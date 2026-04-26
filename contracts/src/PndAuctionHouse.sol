// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {IERC721, IERC165} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";

import {IPndAuctionHouse} from "./IPndAuctionHouse.sol";

/// @title PND Auction House (per-artist clone)
/// @notice ETH-only reserve auctions for ERC721 tokens. Deployed once as the
///         implementation; per-artist EIP-1167 clones (minimal proxies) share
///         this logic but hold isolated storage.
/// @dev No protocol-level admin or upgrade path. Protocol fee + recipient are
///      written once at initialize and have no setters. The artist (owner())
///      can still transfer ownership of their own house via transferOwnership
///      from OwnableUpgradeable.
///
///      ReentrancyGuard uses ERC-7201 namespaced storage (a fixed slot computed
///      from a unique label, not layout slot 0+offset), so the constructor's
///      one-time write to that slot doesn't conflict with proxy storage. The
///      dedicated upgradeable variant was removed in OZ 5.x in favor of this
///      design — verified against openzeppelin-contracts 5.5.x.
///
///      Direct safeTransferFrom(_, house, tokenId, "") is rejected: this
///      contract intentionally does NOT implement IERC721Receiver, so any NFT
///      sent outside createAuction reverts at the source. This prevents NFTs
///      from getting permanently stuck in the contract.
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

    /// @notice Protocol fee in basis points, set once at initialize. Immutable
    ///         after that — no setter exists.
    uint16 public protocolFeeBps;

    /// @notice Recipient for the protocol fee, set once at initialize.
    address payable public feeRecipient;

    uint256 private _nextAuctionId;

    /// @dev Reserved storage for future upgrades. Unused today (no upgrade
    ///      path), kept so a future migration to an upgradeable variant could
    ///      append fields without storage drift.
    uint256[44] private __gap;

    modifier auctionExists(uint256 auctionId) {
        if (!_exists(auctionId)) revert AuctionDoesNotExist();
        _;
    }

    /// @dev Disable initializers on the implementation contract so it can never
    ///      be initialized directly — only via clones.
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializer for each per-artist clone. Sets the artist as the
    ///         owner, locks the protocol fee + recipient, and disables further
    ///         init via Initializable. There are no setters for any of these
    ///         after this call.
    /// @param artistOwner          The artist who owns this auction house.
    /// @param feeRecipient_        Where the protocol fee is paid to.
    /// @param protocolFeeBps_      Protocol fee in basis points. Capped at 500
    ///                             (5%) at the impl level as a sanity check.
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
        return _createAuction(
            tokenId,
            tokenContract,
            duration,
            reservePrice,
            curator,
            curatorFeeBps
        );
    }

    /// @notice Create many auctions in one tx. All share the same duration,
    ///         reserve, curator, and curator fee — call individually if pieces
    ///         need different settings. Atomic: any failure (token not owned,
    ///         not approved, etc.) reverts the whole batch.
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
        // A non-zero curator fee with no curator is meaningless and would
        // produce a misleading event payload. Reject the inconsistent input.
        if (curator == address(0)) {
            require(curatorFeeBps == 0, "curator fee without curator");
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

        // Reject zero-value bids explicitly. Otherwise reserve = 0 + amount = 0
        // would slip past the reserve and increment checks below and start an
        // auction "for free", which we do not consider a feature.
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
            // Refund the previous bidder. If the direct send fails (contract
            // wallets that revert on receive), credit a withdrawable balance
            // instead so the auction never gets bricked.
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

        // Plain transferFrom (not safeTransferFrom): a contract bidder that
        // can't receive ERC721s is the bidder's own problem, not a free
        // auction-griefing vector. The bidder locked capital to win — if they
        // can't take delivery, they've burned ETH for nothing, but the auction
        // does still settle on chain (NFT transfers, fees pay out).
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

    /// @notice Cancel many auctions in one tx. Restricted to the house owner
    ///         (the artist) so a stranger can't grief active listings. Reverts
    ///         the whole batch if any auctionId is invalid or has bids — atomic
    ///         so the caller knows exactly which auctions still exist after.
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
    ///         auctionId if so. The tuple shape removes the ambiguity that the
    ///         old single-uint return had — auctionId 0 is a valid id, so a
    ///         caller couldn't tell "no auction" from "auction 0" without an
    ///         extra check. Use this getter exclusively.
    function getAuctionFor(address tokenContract, uint256 tokenId)
        external
        view
        returns (bool exists, uint256 auctionId)
    {
        uint256 stored = _auctionIdByToken[tokenContract][tokenId];
        if (stored == 0) return (false, 0);
        return (true, stored - 1);
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

    /// @dev Push ETH to `to` if possible; if the recipient rejects (contract
    ///      wallets, reverting fallbacks), credit a withdrawable balance
    ///      instead. Called for bid refunds, protocol fees, curator fees, and
    ///      seller payouts so a single failing recipient never bricks the
    ///      auction's settlement.
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

    /// @notice Reject direct ETH sends so accidental transfers don't get
    ///         stuck. Selfdestruct/coinbase forced ETH bypasses this; that's
    ///         outside our control.
    receive() external payable {
        revert("Direct ETH not accepted");
    }
}
