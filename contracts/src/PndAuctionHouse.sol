// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {IERC721, IERC165} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";

import {IPndAuctionHouse} from "./IPndAuctionHouse.sol";

/// @title PND Auction House (per-artist clone)
/// @notice ETH-only reserve auctions for ERC721 tokens. Deployed once as the
///         beacon implementation; per-artist BeaconProxy clones share this
///         logic but hold isolated storage.
/// @dev Upgrade-safe: storage layout is append-only and reserves a __gap.
///      ReentrancyGuard uses ERC-7201 namespaced storage so it's proxy-safe
///      without the dedicated upgradeable variant (removed in OZ 5.x).
contract PndAuctionHouse is
    IPndAuctionHouse,
    Initializable,
    ReentrancyGuard,
    OwnableUpgradeable,
    IERC721Receiver
{
    /// @notice ERC721 interface id (EIP-721)
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;

    /// @notice Min seconds remaining after a bid; bids in this window extend the auction.
    uint256 public constant TIME_BUFFER = 15 minutes;

    /// @notice Min bid increment over current high bid, in basis points (5%).
    uint16 public constant MIN_BID_INCREMENT_BPS = 500;

    /// @notice Hard cap for the protocol fee. Can never be raised above this without
    ///         a new implementation deployed via beacon upgrade.
    uint16 public constant PROTOCOL_FEE_CAP_BPS = 500; // 5%

    /// @notice Per-auction state.
    mapping(uint256 => Auction) public auctions;

    /// @notice Reverse index: (tokenContract, tokenId) -> auctionId. Stores
    ///         auctionId+1 so the zero default unambiguously means "none";
    ///         consumers should subtract 1. Cleared on settle/cancel.
    mapping(address => mapping(uint256 => uint256)) private _auctionIdByToken;

    /// @notice Pending refunds for bidders whose direct ETH refund failed
    ///         (e.g. contract wallets that revert on receive). Withdrawable
    ///         at any time via withdrawRefund().
    mapping(address => uint256) public pendingRefunds;

    /// @notice Active protocol fee in basis points. Settable by protocolFeeAdmin only,
    ///         capped at PROTOCOL_FEE_CAP_BPS.
    uint16 public protocolFeeBps;

    /// @notice Recipient for the protocol fee. Settable by protocolFeeAdmin only.
    address payable public feeRecipient;

    /// @notice Address authorized to change protocol fee config. Distinct from
    ///         the artist owner so PND can adjust platform economics without
    ///         taking control of the artist's auctions.
    address public protocolFeeAdmin;

    uint256 private _nextAuctionId;

    /// @dev Reserved storage for future upgrades. Must shrink when adding new
    ///      state to keep the layout stable across beacon upgrades.
    uint256[43] private __gap;

    modifier auctionExists(uint256 auctionId) {
        require(_exists(auctionId), "Auction does not exist");
        _;
    }

    modifier onlyProtocolFeeAdmin() {
        require(msg.sender == protocolFeeAdmin, "Not protocol fee admin");
        _;
    }

    /// @dev Disable initializers on the implementation contract so it can never
    ///      be initialized directly — only via clones.
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializer for each per-artist clone.
    /// @param artistOwner          The artist who owns this auction house and
    ///                             can run/cancel/update auctions on it.
    /// @param protocolFeeAdmin_    Address authorized to set protocol fee + recipient.
    /// @param feeRecipient_        Where the protocol fee is paid to.
    /// @param initialProtocolFeeBps Initial fee in basis points (must be <= cap).
    function initialize(
        address artistOwner,
        address protocolFeeAdmin_,
        address payable feeRecipient_,
        uint16 initialProtocolFeeBps
    ) external initializer {
        require(artistOwner != address(0), "artist owner required");
        require(protocolFeeAdmin_ != address(0), "fee admin required");
        require(initialProtocolFeeBps <= PROTOCOL_FEE_CAP_BPS, "initial fee above cap");
        require(
            initialProtocolFeeBps == 0 || feeRecipient_ != address(0),
            "fee recipient required when fee > 0"
        );

        __Ownable_init(artistOwner);

        protocolFeeAdmin = protocolFeeAdmin_;
        feeRecipient = feeRecipient_;
        protocolFeeBps = initialProtocolFeeBps;
    }

    // ─── Auction lifecycle ──────────────────────────────────────────────────

    /// @notice Create an auction in this house. Restricted to the house owner
    ///         (the artist) so a stranger can't spam someone else's venue with
    ///         random NFTs. The artist must own the NFT or be approved for it
    ///         on the source ERC721 contract.
    function createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice,
        address payable curator,
        uint16 curatorFeeBps
    ) external override nonReentrant onlyOwner returns (uint256) {
        require(
            IERC165(tokenContract).supportsInterface(ERC721_INTERFACE_ID),
            "tokenContract is not ERC721"
        );
        require(curatorFeeBps < 10000, "curator fee >= 100%");
        require(duration > 0, "duration zero");

        address tokenOwner = IERC721(tokenContract).ownerOf(tokenId);
        require(
            msg.sender == tokenOwner ||
                msg.sender == IERC721(tokenContract).getApproved(tokenId) ||
                IERC721(tokenContract).isApprovedForAll(tokenOwner, msg.sender),
            "Not token owner or approved"
        );

        uint256 auctionId = _nextAuctionId++;

        auctions[auctionId] = Auction({
            tokenId: tokenId,
            tokenContract: tokenContract,
            approved: false,
            amount: 0,
            duration: duration,
            firstBidTime: 0,
            reservePrice: reservePrice,
            curatorFeeBps: curatorFeeBps,
            tokenOwner: tokenOwner,
            bidder: payable(address(0)),
            curator: curator
        });

        _auctionIdByToken[tokenContract][tokenId] = auctionId + 1;
        IERC721(tokenContract).transferFrom(tokenOwner, address(this), tokenId);

        emit AuctionCreated(
            auctionId,
            tokenId,
            tokenContract,
            duration,
            reservePrice,
            tokenOwner,
            curator,
            curatorFeeBps
        );

        if (curator == address(0) || curator == tokenOwner) {
            _approveAuction(auctionId, true);
        }

        return auctionId;
    }

    function setAuctionApproval(uint256 auctionId, bool approved)
        external
        override
        auctionExists(auctionId)
    {
        require(msg.sender == auctions[auctionId].curator, "Not auction curator");
        require(auctions[auctionId].firstBidTime == 0, "Auction already started");
        _approveAuction(auctionId, approved);
    }

    function setAuctionReservePrice(uint256 auctionId, uint256 reservePrice)
        external
        override
        auctionExists(auctionId)
    {
        Auction storage a = auctions[auctionId];
        require(
            msg.sender == a.tokenOwner || msg.sender == a.curator,
            "Not token owner or curator"
        );
        require(a.firstBidTime == 0, "Auction already started");

        a.reservePrice = reservePrice;
        emit AuctionReservePriceUpdated(auctionId, reservePrice);
    }

    function createBid(uint256 auctionId)
        external
        payable
        override
        auctionExists(auctionId)
        nonReentrant
    {
        Auction storage a = auctions[auctionId];
        address payable lastBidder = a.bidder;
        uint256 amount = msg.value;

        require(a.approved, "Auction not approved");
        require(
            a.firstBidTime == 0 ||
                block.timestamp < a.firstBidTime + a.duration,
            "Auction expired"
        );
        require(amount >= a.reservePrice, "Below reserve price");
        require(
            amount >= a.amount + (a.amount * MIN_BID_INCREMENT_BPS) / 10000,
            "Below min bid increment"
        );

        bool firstBid = a.firstBidTime == 0;
        if (firstBid) {
            a.firstBidTime = block.timestamp;
        } else if (lastBidder != address(0)) {
            // Refund the previous bidder. If the direct send fails (contract
            // wallets that revert on receive), credit a withdrawable balance
            // instead so the auction never gets bricked.
            _refund(lastBidder, a.amount);
        }

        a.amount = amount;
        a.bidder = payable(msg.sender);

        bool extended = false;
        uint256 endsAt = a.firstBidTime + a.duration;
        if (endsAt - block.timestamp < TIME_BUFFER) {
            unchecked {
                a.duration = a.duration + (TIME_BUFFER - (endsAt - block.timestamp));
            }
            extended = true;
        }

        emit AuctionBid(auctionId, msg.sender, amount, firstBid, extended);

        if (extended) {
            emit AuctionDurationExtended(auctionId, a.duration);
        }
    }

    function endAuction(uint256 auctionId)
        external
        override
        auctionExists(auctionId)
        nonReentrant
    {
        Auction storage a = auctions[auctionId];
        require(a.firstBidTime != 0, "Auction has no bids");
        require(
            block.timestamp >= a.firstBidTime + a.duration,
            "Auction not yet ended"
        );

        // Try transferring the NFT to the winner. If the transfer fails (e.g.
        // winner is a contract that doesn't implement onERC721Received), refund
        // the winner's bid and cancel the auction so the seller gets the NFT back.
        try
            IERC721(a.tokenContract).safeTransferFrom(address(this), a.bidder, a.tokenId)
        {} catch {
            _refund(a.bidder, a.amount);
            _cancelAuction(auctionId);
            return;
        }

        // Compute payout: protocol fee → curator fee → seller.
        uint256 grossAmount = a.amount;
        uint256 protocolFee;
        uint256 curatorFee;

        if (protocolFeeBps > 0 && feeRecipient != address(0)) {
            protocolFee = (grossAmount * protocolFeeBps) / 10000;
            _refund(feeRecipient, protocolFee);
        }

        uint256 afterProtocol = grossAmount - protocolFee;

        if (a.curator != address(0) && a.curatorFeeBps > 0) {
            curatorFee = (afterProtocol * a.curatorFeeBps) / 10000;
            _refund(a.curator, curatorFee);
        }

        uint256 sellerProceeds = afterProtocol - curatorFee;
        _refund(payable(a.tokenOwner), sellerProceeds);

        emit AuctionEnded(
            auctionId,
            a.tokenOwner,
            a.curator,
            a.bidder,
            sellerProceeds,
            curatorFee,
            protocolFee
        );

        delete _auctionIdByToken[a.tokenContract][a.tokenId];
        delete auctions[auctionId];
    }

    function cancelAuction(uint256 auctionId)
        external
        override
        nonReentrant
        auctionExists(auctionId)
    {
        Auction storage a = auctions[auctionId];
        require(
            a.tokenOwner == msg.sender || a.curator == msg.sender,
            "Not auction creator or curator"
        );
        require(a.firstBidTime == 0, "Auction already started");
        _cancelAuction(auctionId);
    }

    // ─── Refunds ────────────────────────────────────────────────────────────

    function withdrawRefund() external override nonReentrant {
        uint256 amount = pendingRefunds[msg.sender];
        require(amount > 0, "No refund available");
        pendingRefunds[msg.sender] = 0;
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Withdraw failed");
        emit RefundWithdrawn(msg.sender, amount);
    }

    // ─── Protocol fee admin ─────────────────────────────────────────────────

    function setProtocolFeeBps(uint16 newBps) external override onlyProtocolFeeAdmin {
        require(newBps <= PROTOCOL_FEE_CAP_BPS, "Above cap");
        require(newBps == 0 || feeRecipient != address(0), "Recipient unset");
        protocolFeeBps = newBps;
        emit ProtocolFeeUpdated(newBps);
    }

    function setFeeRecipient(address payable newRecipient)
        external
        override
        onlyProtocolFeeAdmin
    {
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }

    function setProtocolFeeAdmin(address newAdmin) external override onlyProtocolFeeAdmin {
        require(newAdmin != address(0), "Zero address");
        protocolFeeAdmin = newAdmin;
        emit ProtocolFeeAdminUpdated(newAdmin);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Returns the active auctionId for (tokenContract, tokenId), or 0
    ///         if no active auction. Note: the contract uses 0 as a valid
    ///         auctionId internally; callers should also check that the auction
    ///         exists via auctions(id).tokenOwner != address(0) before using it.
    function getAuctionIdFor(address tokenContract, uint256 tokenId)
        external
        view
        returns (uint256)
    {
        uint256 stored = _auctionIdByToken[tokenContract][tokenId];
        if (stored == 0) return 0;
        return stored - 1;
    }

    /// @notice True iff there's an active auction for (tokenContract, tokenId).
    function hasAuctionFor(address tokenContract, uint256 tokenId)
        external
        view
        returns (bool)
    {
        return _auctionIdByToken[tokenContract][tokenId] != 0;
    }

    function getMinBidAmount(uint256 auctionId) external view returns (uint256) {
        Auction storage a = auctions[auctionId];
        if (a.tokenOwner == address(0)) return 0;
        if (a.amount == 0) return a.reservePrice;
        return a.amount + (a.amount * MIN_BID_INCREMENT_BPS) / 10000;
    }

    function nextAuctionId() external view returns (uint256) {
        return _nextAuctionId;
    }

    // ─── Internal ───────────────────────────────────────────────────────────

    function _refund(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool sent, ) = to.call{value: amount, gas: 30000}("");
        if (!sent) {
            pendingRefunds[to] += amount;
            emit RefundCredited(to, amount);
        }
    }

    function _cancelAuction(uint256 auctionId) internal {
        Auction storage a = auctions[auctionId];
        address tokenOwner = a.tokenOwner;
        address tokenContract = a.tokenContract;
        uint256 tokenId = a.tokenId;
        IERC721(tokenContract).safeTransferFrom(address(this), tokenOwner, tokenId);
        emit AuctionCanceled(auctionId);
        delete _auctionIdByToken[tokenContract][tokenId];
        delete auctions[auctionId];
    }

    function _approveAuction(uint256 auctionId, bool approved) internal {
        auctions[auctionId].approved = approved;
        emit AuctionApprovalUpdated(auctionId, approved);
    }

    function _exists(uint256 auctionId) internal view returns (bool) {
        return auctions[auctionId].tokenOwner != address(0);
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}
