// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "openzeppelin-contracts/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";

import {IPndAuctionHouse} from "./IPndAuctionHouse.sol";

/// @title PND Auction House (per-artist clone)
/// @notice ETH-only reserve auctions for ERC721 tokens. Deployed once as the
///         implementation; per-artist EIP-1167 clones (minimal proxies) share
///         this logic but hold isolated storage.
/// @dev No protocol-level admin or upgrade path. Protocol fee + recipient
///      are written once at initialize. Artist ownership is also locked at
///      deploy: transferOwnership and renounceOwnership are overridden to
///      revert, so the house cannot be reassigned away from the original
///      artist (and the factory's artist→house map stays stable). To change
///      protocol fee, recipient, or implementation logic, deploy a new
///      factory.
///
///      ReentrancyGuard uses ERC-7201 namespaced storage (a fixed slot
///      computed from a unique label), so the constructor's one-time write
///      to that slot doesn't conflict with proxy storage. The dedicated
///      upgradeable variant (ReentrancyGuardUpgradeable) was removed in
///      OZ 5.x in favor of this design and does not exist in our installed
///      OZ 5.6.1 — the non-upgradeable guard is the correct choice here.
///
///      ERC721 transfers IN: transferFrom only. The contract intentionally
///      does NOT implement IERC721Receiver, so direct safeTransferFrom from
///      outside reverts at the source.
///
///      Settlement uses plain transferFrom (closes the contract-bidder
///      griefing path that affected Zora's original safeTransferFrom + try/
///      catch design).
///
///      Direct ETH sends are rejected via receive(). Selfdestruct/coinbase
///      forced ETH is outside our control.
contract PndAuctionHouse is
    IPndAuctionHouse,
    Initializable,
    ReentrancyGuard,
    OwnableUpgradeable
{
    /// @notice ERC721 interface id (EIP-721)
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;

    /// @notice Min seconds remaining after a bid; bids in this window extend the auction.
    uint256 public constant TIME_BUFFER = 15 minutes;

    /// @notice Min bid increment over current high bid, in basis points (5%).
    uint16 public constant MIN_BID_INCREMENT_BPS = 500;

    // ─── Custom errors (hot-path reverts) ───────────────────────────────────

    error AuctionDoesNotExist();
    error AuctionAlreadyStarted();
    error AuctionExpired();
    error AuctionNotApproved();
    error AuctionNotEnded();
    error AuctionHasNoBids();
    error BidBelowReserve();
    error BidBelowMinimum();
    error BidMustBePositive();
    error AuctionAlreadyExistsForToken();
    error OwnershipLocked();
    error EscrowFailed();

    /// @notice Per-auction state.
    mapping(uint256 => Auction) public auctions;

    /// @notice Reverse index: (tokenContract, tokenId) -> auctionId+1. Stores
    ///         auctionId+1 so the zero default unambiguously means "none".
    ///         Cleared on settle/cancel. Read via getAuctionFor.
    mapping(address => mapping(uint256 => uint256)) private _auctionIdByToken;

    /// @notice Pending refunds for bidders whose direct ETH refund failed
    ///         (e.g. contract wallets that revert on receive). Withdrawable
    ///         at any time via withdrawRefund().
    mapping(address => uint256) public pendingRefunds;

    /// @notice Protocol fee in basis points, set once at initialize.
    uint16 public protocolFeeBps;

    /// @notice Recipient for the protocol fee, set once at initialize.
    address payable public feeRecipient;

    uint256 private _nextAuctionId;

    modifier auctionExists(uint256 auctionId) {
        if (!_exists(auctionId)) revert AuctionDoesNotExist();
        _;
    }

    /// @dev Disable initializers on the implementation contract so it can never
    ///      be initialized directly — only via clones.
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializer for each per-artist clone.
    /// @param artistOwner          The artist who owns this auction house.
    ///                             Locked: cannot be transferred or renounced.
    /// @param feeRecipient_        Where the protocol fee is paid to.
    /// @param protocolFeeBps_      Protocol fee in basis points (capped at 5%).
    function initialize(
        address artistOwner,
        address payable feeRecipient_,
        uint16 protocolFeeBps_
    ) external initializer {
        require(artistOwner != address(0), "artist owner required");
        require(protocolFeeBps_ <= 500, "fee above cap");
        require(
            protocolFeeBps_ == 0 || feeRecipient_ != address(0),
            "fee recipient required when fee > 0"
        );

        __Ownable_init(artistOwner);
        feeRecipient = feeRecipient_;
        protocolFeeBps = protocolFeeBps_;
    }

    // ─── Ownership lockdown ─────────────────────────────────────────────────

    /// @notice Ownership is locked to the artist set at initialize. The house
    ///         can't be reassigned or renounced, keeping the factory's
    ///         artist-to-house mapping stable. (A compromised artist key can
    ///         still operate auctions on this house — locking ownership only
    ///         prevents the house itself from changing hands.)
    function transferOwnership(address) public pure override {
        revert OwnershipLocked();
    }

    function renounceOwnership() public pure override {
        revert OwnershipLocked();
    }

    // ─── Auction creation ───────────────────────────────────────────────────

    function createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice,
        address payable curator,
        uint16 curatorFeeBps
    ) external override nonReentrant onlyOwner returns (uint256) {
        return _createAuction(
            tokenId,
            tokenContract,
            duration,
            reservePrice,
            curator,
            curatorFeeBps
        );
    }

    function bulkCreateAuctions(
        address tokenContract,
        uint256[] calldata tokenIds,
        uint256 reservePrice,
        uint256 duration,
        address payable curator,
        uint16 curatorFeeBps
    ) external override nonReentrant onlyOwner returns (uint256[] memory auctionIds) {
        auctionIds = new uint256[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            auctionIds[i] = _createAuction(
                tokenIds[i],
                tokenContract,
                duration,
                reservePrice,
                curator,
                curatorFeeBps
            );
        }
    }

    function _createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice,
        address payable curator,
        uint16 curatorFeeBps
    ) internal returns (uint256) {
        require(
            IERC165(tokenContract).supportsInterface(ERC721_INTERFACE_ID),
            "tokenContract is not ERC721"
        );
        require(curatorFeeBps < 10000, "curator fee >= 100%");
        require(duration > 0, "duration zero");
        if (curator == address(0)) {
            require(curatorFeeBps == 0, "curator fee without curator");
        }
        if (_auctionIdByToken[tokenContract][tokenId] != 0) {
            revert AuctionAlreadyExistsForToken();
        }

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
        // Belt-and-suspenders escrow check: a malicious ERC721 that claims
        // to transfer but doesn't would otherwise leave us with a registered
        // auction and no NFT.
        if (IERC721(tokenContract).ownerOf(tokenId) != address(this)) {
            revert EscrowFailed();
        }

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

    // ─── Auction lifecycle ──────────────────────────────────────────────────

    function setAuctionApproval(uint256 auctionId, bool approved)
        external
        override
        auctionExists(auctionId)
    {
        require(msg.sender == auctions[auctionId].curator, "Not auction curator");
        if (auctions[auctionId].firstBidTime != 0) revert AuctionAlreadyStarted();
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
        if (a.firstBidTime != 0) revert AuctionAlreadyStarted();

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

        if (amount == 0) revert BidMustBePositive();
        if (!a.approved) revert AuctionNotApproved();
        if (
            a.firstBidTime != 0 &&
            block.timestamp >= a.firstBidTime + a.duration
        ) revert AuctionExpired();
        if (amount < a.reservePrice) revert BidBelowReserve();
        if (
            amount < a.amount + (a.amount * MIN_BID_INCREMENT_BPS) / 10000
        ) revert BidBelowMinimum();

        bool firstBid = a.firstBidTime == 0;
        if (firstBid) {
            a.firstBidTime = block.timestamp;
        } else if (lastBidder != address(0)) {
            _sendOrCredit(lastBidder, a.amount);
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
        if (a.firstBidTime == 0) revert AuctionHasNoBids();
        if (block.timestamp < a.firstBidTime + a.duration) revert AuctionNotEnded();

        // Plain transferFrom: a contract bidder that can't accept ERC721s
        // is the bidder's own problem, not a free auction-griefing vector.
        IERC721(a.tokenContract).transferFrom(address(this), a.bidder, a.tokenId);

        // Compute payout: protocol fee → curator fee → seller.
        uint256 grossAmount = a.amount;
        uint256 protocolFee;
        uint256 curatorFee;

        if (protocolFeeBps > 0 && feeRecipient != address(0)) {
            protocolFee = (grossAmount * protocolFeeBps) / 10000;
            _sendOrCredit(feeRecipient, protocolFee);
        }

        uint256 afterProtocol = grossAmount - protocolFee;

        if (a.curator != address(0) && a.curatorFeeBps > 0) {
            curatorFee = (afterProtocol * a.curatorFeeBps) / 10000;
            _sendOrCredit(a.curator, curatorFee);
        }

        uint256 sellerProceeds = afterProtocol - curatorFee;
        _sendOrCredit(payable(a.tokenOwner), sellerProceeds);

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
        if (a.firstBidTime != 0) revert AuctionAlreadyStarted();
        _cancelAuction(auctionId);
    }

    function bulkCancelAuctions(uint256[] calldata auctionIds)
        external
        override
        nonReentrant
        onlyOwner
    {
        for (uint256 i = 0; i < auctionIds.length; i++) {
            uint256 auctionId = auctionIds[i];
            if (!_exists(auctionId)) revert AuctionDoesNotExist();
            if (auctions[auctionId].firstBidTime != 0) revert AuctionAlreadyStarted();
            _cancelAuction(auctionId);
        }
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

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Returns whether an active auction exists for a token, and its
    ///         auctionId. Tuple shape disambiguates "no auction" from
    ///         "auction id 0" — both are otherwise indistinguishable.
    function getAuctionFor(address tokenContract, uint256 tokenId)
        external
        view
        returns (bool exists, uint256 auctionId)
    {
        uint256 stored = _auctionIdByToken[tokenContract][tokenId];
        if (stored == 0) return (false, 0);
        return (true, stored - 1);
    }

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

    /// @dev Push ETH to `to` if possible; if the recipient rejects, credit
    ///      a withdrawable balance instead. Used for bid refunds, protocol
    ///      fees, curator fees, and seller payouts so a single failing
    ///      recipient never bricks the auction's settlement.
    function _sendOrCredit(address to, uint256 amount) internal {
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
        IERC721(tokenContract).transferFrom(address(this), tokenOwner, tokenId);
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

    /// @notice Reject direct ETH sends. Selfdestruct/coinbase forced ETH
    ///         bypasses this; outside our control.
    receive() external payable {
        revert("Direct ETH not accepted");
    }
}
