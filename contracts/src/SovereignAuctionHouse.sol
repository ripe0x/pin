// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {
    IERC721
} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {
    IERC165
} from "openzeppelin-contracts/contracts/utils/introspection/IERC165.sol";
import {
    ReentrancyGuard
} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {
    Initializable
} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {
    OwnableUpgradeable
} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";

import {ISovereignAuctionHouse} from "./ISovereignAuctionHouse.sol";

/// @title Sovereign Auction House
/// @notice ETH-only reserve auctions for ERC721 tokens. Deployed once as the
///         implementation; one EIP-1167 clone (minimal proxy) per owner —
///         every seller (artist or collector) deploys and runs their own
///         house with isolated storage.
/// @dev No protocol-level admin or upgrade path. Protocol fee + recipient
///      are written once at initialize. House ownership is also locked at
///      deploy: transferOwnership and renounceOwnership are overridden to
///      revert, so the house cannot be reassigned away from its original
///      owner (and the factory's owner→house map stays stable). To change
///      protocol fee, recipient, or implementation logic, deploy a new
///      factory.
///
///      The owner can recover an ERC721 that landed on the contract outside
///      of the auction flow (e.g. a manual transferFrom by the original
///      holder) via recoverStuckERC721, but cannot touch any token that is
///      currently registered as an active auction — the reverse-index map
///      gates the call. If multiple users mistakenly send NFTs to one
///      house, all of those NFTs are recoverable only by the house owner,
///      who is socially expected to return them but is not programmatically
///      forced to. The active-auction map prevents the owner from touching
///      tokens currently registered in an auction.
///
///      ReentrancyGuard uses ERC-7201 namespaced storage (a fixed slot
///      computed from a unique label), so the constructor's one-time write
///      to that slot doesn't conflict with proxy storage. The dedicated
///      upgradeable variant (ReentrancyGuardUpgradeable) was removed in
///      OZ 5.x in favor of this design and does not exist in our installed
///      OZ 5.6.1 — the non-upgradeable guard is the correct choice here.
///      Initialize warms that slot on each clone (clones don't run the
///      implementation's constructor) so the first nonReentrant call pays
///      the cheaper SSTORE-from-1 gas path.
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
contract SovereignAuctionHouse is
    ISovereignAuctionHouse,
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

    /// @notice Sanity cap on createAuction durations. 100 years is well below
    ///         uint64 timestamps and rules out absurd inputs.
    uint256 private constant MAX_DURATION = 365 days * 100;

    // ─── Custom errors (hot-path reverts) ───────────────────────────────────

    /// @notice The given auctionId has no live auction in storage.
    error AuctionDoesNotExist();
    /// @notice An action that requires the auction to be pre-bid was attempted
    ///         after the first bid landed (e.g. cancel, edit reserve).
    error AuctionAlreadyStarted();
    /// @notice A bid landed after the auction's end time.
    error AuctionExpired();
    /// @notice endAuction was called before the timer ran out.
    error AuctionNotEnded();
    /// @notice endAuction was called on an auction with no bids.
    error AuctionHasNoBids();
    /// @notice First bid was below the reserve price.
    error BidBelowReserve();
    /// @notice Bid was below previous + MIN_BID_INCREMENT_BPS (with 1-wei floor).
    error BidBelowMinimum();
    /// @notice msg.value was zero. Use a separate "free auction" feature if
    ///         we ever want explicit zero-priced auctions.
    error BidMustBePositive();
    /// @notice A second auction was attempted for a (tokenContract, tokenId)
    ///         that already has one registered here. Cancel/settle the first
    ///         to free the slot.
    error AuctionAlreadyExistsForToken();
    /// @notice Caller tried transferOwnership or renounceOwnership; both are
    ///         intentionally disabled (see contract NatSpec).
    error OwnershipLocked();
    /// @notice Post-transfer ownerOf check disagreed with where the token
    ///         should be. Indicates a malicious or non-standard ERC721.
    error EscrowFailed();

    /// @notice Per-auction state.
    /// @dev Storage layout (after curator removal + endTime refactor):
    ///        slot 0: tokenId (uint256)
    ///        slot 1: tokenContract (160) | firstBidTime (64) | 32 bits free
    ///        slot 2: amount (uint256)
    ///        slot 3: reservePrice (uint256)
    ///        slot 4: tokenOwner (160) | endTime (64) | 32 bits free
    ///        slot 5: bidder (160) | duration (64) | 32 bits free
    ///      Total: 6 slots. firstBidTime, endTime, and duration are uint64
    ///      seconds — comfortably above any realistic auction lifetime.
    ///      duration is captured at create time and consumed on the first
    ///      bid to compute endTime; it's left in storage afterwards so
    ///      indexers + clients can read it cheaply without re-deriving it
    ///      from (endTime - firstBidTime), which would be wrong after a
    ///      late-bid extension.
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

    /// @notice Initializer for each per-owner clone.
    /// @param initialOwner         The address that owns this auction house —
    ///                             whoever called createAuctionHouse on the
    ///                             factory. Locked: cannot be transferred or
    ///                             renounced after init.
    /// @param feeRecipient_        Where the protocol fee is paid to.
    /// @param protocolFeeBps_      Protocol fee in basis points (capped at 5%).
    function initialize(
        address initialOwner,
        address payable feeRecipient_,
        uint16 protocolFeeBps_
    ) external initializer {
        require(initialOwner != address(0), "owner required");
        require(protocolFeeBps_ <= 500, "fee above cap");
        require(
            protocolFeeBps_ == 0 || feeRecipient_ != address(0),
            "fee recipient required when fee > 0"
        );

        __Ownable_init(initialOwner);
        feeRecipient = feeRecipient_;
        protocolFeeBps = protocolFeeBps_;

        // Warm the ReentrancyGuard slot so the first nonReentrant call on this
        // clone pays the cheaper SSTORE-from-1 path instead of from-0. Clones
        // don't run the implementation's constructor, so without this the slot
        // would start at zero. The guard's check is `value == ENTERED (=2)`, so
        // either zero or NOT_ENTERED (=1) reads as "not entered" — but starting
        // from 1 is what OZ's gas-cost reasoning assumes.
        // Slot constant verified against OZ 5.6.1's ReentrancyGuard.sol
        // (REENTRANCY_GUARD_STORAGE, NOT_ENTERED = 1, ENTERED = 2).
        bytes32 slot = 0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;
        assembly {
            sstore(slot, 1)
        }
    }

    // ─── Ownership lockdown ─────────────────────────────────────────────────

    /// @notice Ownership is locked to the address set at initialize. The
    ///         house can't be reassigned or renounced, keeping the factory's
    ///         owner-to-house mapping stable. (A compromised owner key can
    ///         still operate auctions on this house — locking ownership only
    ///         prevents the house itself from changing hands.)
    function transferOwnership(address) public pure override {
        revert OwnershipLocked();
    }

    function renounceOwnership() public pure override {
        revert OwnershipLocked();
    }

    // ─── Auction creation ───────────────────────────────────────────────────

    /// @inheritdoc ISovereignAuctionHouse
    /// @dev Owner-only: each house has one owner; only they can register
    ///      auctions on it. Token ownership/approval is checked separately
    ///      below so the owner can only escrow tokens they actually control.
    function createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice
    ) external override nonReentrant onlyOwner returns (uint256) {
        return _createAuction(tokenId, tokenContract, duration, reservePrice);
    }

    /// @inheritdoc ISovereignAuctionHouse
    /// @dev Owner-only. Reverts the whole batch if any single auction fails
    ///      to register (e.g. unapproved transfer, duplicate listing).
    function bulkCreateAuctions(
        address tokenContract,
        uint256[] calldata tokenIds,
        uint256 reservePrice,
        uint256 duration
    )
        external
        override
        nonReentrant
        onlyOwner
        returns (uint256[] memory auctionIds)
    {
        auctionIds = new uint256[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            auctionIds[i] = _createAuction(
                tokenIds[i],
                tokenContract,
                duration,
                reservePrice
            );
        }
    }

    function _createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice
    ) internal returns (uint256) {
        require(
            IERC165(tokenContract).supportsInterface(ERC721_INTERFACE_ID),
            "tokenContract is not ERC721"
        );
        require(duration > 0, "duration zero");
        require(duration <= MAX_DURATION, "duration too large");
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
            firstBidTime: 0,
            amount: 0,
            reservePrice: reservePrice,
            tokenOwner: tokenOwner,
            endTime: 0,
            bidder: payable(address(0)),
            duration: uint64(duration)
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
            tokenOwner
        );

        return auctionId;
    }

    // ─── Auction lifecycle ──────────────────────────────────────────────────

    /// @inheritdoc ISovereignAuctionHouse
    function setAuctionReservePrice(
        uint256 auctionId,
        uint256 reservePrice
    ) external override auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        require(msg.sender == a.tokenOwner, "Not token owner");
        if (a.firstBidTime != 0) revert AuctionAlreadyStarted();

        a.reservePrice = reservePrice;
        emit AuctionReservePriceUpdated(auctionId, reservePrice);
    }

    /// @inheritdoc ISovereignAuctionHouse
    /// @dev Late bids (within TIME_BUFFER of the end) extend the auction so
    ///      every bidder gets at least TIME_BUFFER to respond. Outbid
    ///      previous bidder is refunded directly; if their refund push
    ///      reverts (e.g. contract wallet) the amount is credited to
    ///      pendingRefunds instead so the bid flow doesn't brick.
    function createBid(
        uint256 auctionId
    ) external payable override auctionExists(auctionId) nonReentrant {
        Auction storage a = auctions[auctionId];
        address payable lastBidder = a.bidder;
        uint256 amount = msg.value;

        if (amount == 0) revert BidMustBePositive();
        if (a.firstBidTime != 0 && block.timestamp >= a.endTime)
            revert AuctionExpired();
        if (amount < a.reservePrice) revert BidBelowReserve();

        // Bid must strictly exceed previous + 5% increment, with a 1-wei
        // floor so a tiny prior bid (where the bps math rounds to zero)
        // can't be matched exactly.
        if (a.amount > 0) {
            uint256 increment = (a.amount * MIN_BID_INCREMENT_BPS) / 10000;
            if (increment == 0) increment = 1;
            uint256 minNext = a.amount + increment;
            if (amount < minNext) revert BidBelowMinimum();
        }

        bool firstBid = a.firstBidTime == 0;
        if (firstBid) {
            uint64 nowTs = uint64(block.timestamp);
            a.firstBidTime = nowTs;
            // endTime = firstBidTime + duration; both fit in uint64. Duration
            // was bounded to MAX_DURATION at create time so the addition
            // can't overflow uint64.
            a.endTime = nowTs + a.duration;
        } else if (lastBidder != address(0)) {
            _sendOrCredit(lastBidder, a.amount);
        }

        a.amount = amount;
        a.bidder = payable(msg.sender);

        // Late-bid extension: any bid inside the last TIME_BUFFER pushes
        // endTime out by enough to give every bidder TIME_BUFFER to respond.
        // The `block.timestamp + TIME_BUFFER` cast to uint64 is safe because
        // MAX_DURATION + max plausible block.timestamp is comfortably below
        // uint64 max (~1.8e19), so truncation cannot occur.
        bool extended = false;
        if (a.endTime - block.timestamp < TIME_BUFFER) {
            a.endTime = uint64(block.timestamp + TIME_BUFFER);
            extended = true;
        }

        emit AuctionBid(auctionId, msg.sender, amount, firstBid, extended);

        if (extended) {
            emit AuctionEndTimeUpdated(auctionId, a.endTime);
        }
    }

    /// @inheritdoc ISovereignAuctionHouse
    /// @dev Permissionless: anyone can settle an ended auction. Payouts use
    ///      _sendOrCredit so a single failing recipient never blocks the
    ///      others — they get their funds via withdrawRefund() instead.
    function endAuction(
        uint256 auctionId
    ) external override auctionExists(auctionId) nonReentrant {
        Auction storage a = auctions[auctionId];
        if (a.firstBidTime == 0) revert AuctionHasNoBids();
        if (block.timestamp < a.endTime) revert AuctionNotEnded();

        // Plain transferFrom: a contract bidder that can't accept ERC721s
        // is the bidder's own problem, not a free auction-griefing vector.
        IERC721(a.tokenContract).transferFrom(
            address(this),
            a.bidder,
            a.tokenId
        );

        // Compute payout: gross → protocol fee → seller.
        uint256 grossAmount = a.amount;
        uint256 protocolFee;

        // Initialize() invariant: protocolFeeBps > 0 implies feeRecipient != 0,
        // so we don't need the second-clause check here.
        if (protocolFeeBps > 0) {
            protocolFee = (grossAmount * protocolFeeBps) / 10000;
            _sendOrCredit(feeRecipient, protocolFee);
        }

        uint256 sellerProceeds = grossAmount - protocolFee;
        _sendOrCredit(payable(a.tokenOwner), sellerProceeds);

        emit AuctionEnded(
            auctionId,
            a.tokenOwner,
            a.bidder,
            sellerProceeds,
            protocolFee
        );

        delete _auctionIdByToken[a.tokenContract][a.tokenId];
        delete auctions[auctionId];
    }

    /// @inheritdoc ISovereignAuctionHouse
    function cancelAuction(
        uint256 auctionId
    ) external override nonReentrant auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        require(a.tokenOwner == msg.sender, "Not token owner");
        if (a.firstBidTime != 0) revert AuctionAlreadyStarted();
        _cancelAuction(auctionId);
    }

    /// @inheritdoc ISovereignAuctionHouse
    function bulkCancelAuctions(
        uint256[] calldata auctionIds
    ) external override nonReentrant onlyOwner {
        for (uint256 i = 0; i < auctionIds.length; i++) {
            uint256 auctionId = auctionIds[i];
            if (!_exists(auctionId)) revert AuctionDoesNotExist();
            if (auctions[auctionId].firstBidTime != 0)
                revert AuctionAlreadyStarted();
            _cancelAuction(auctionId);
        }
    }

    // ─── Refunds ────────────────────────────────────────────────────────────

    /// @inheritdoc ISovereignAuctionHouse
    function withdrawRefund() external override nonReentrant {
        uint256 amount = pendingRefunds[msg.sender];
        require(amount > 0, "No refund available");
        pendingRefunds[msg.sender] = 0;
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Withdraw failed");
        emit RefundWithdrawn(msg.sender, amount);
    }

    // ─── Stuck-NFT recovery ─────────────────────────────────────────────────

    /// @notice Owner-only escape hatch for ERC721s that landed on this
    ///         contract outside of the auction flow (e.g. a holder did a
    ///         plain transferFrom directly to the house). Cannot be used to
    ///         touch any token that is currently registered as an active
    ///         auction — the reverse-index gates the call.
    function recoverStuckERC721(
        address tokenContract,
        uint256 tokenId,
        address to
    ) external onlyOwner nonReentrant {
        require(to != address(0), "to required");
        if (_auctionIdByToken[tokenContract][tokenId] != 0) {
            revert AuctionAlreadyExistsForToken();
        }
        IERC721(tokenContract).transferFrom(address(this), to, tokenId);
        emit StuckERC721Recovered(tokenContract, tokenId, to);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Returns whether an active auction exists for a token, and its
    ///         auctionId. Tuple shape disambiguates "no auction" from
    ///         "auction id 0" — both are otherwise indistinguishable.
    function getAuctionFor(
        address tokenContract,
        uint256 tokenId
    ) external view returns (bool exists, uint256 auctionId) {
        uint256 stored = _auctionIdByToken[tokenContract][tokenId];
        if (stored == 0) return (false, 0);
        return (true, stored - 1);
    }

    /// @notice Cheap boolean check for "is this token currently in auction
    ///         here?" — useful when the auctionId itself isn't needed.
    function hasAuctionFor(
        address tokenContract,
        uint256 tokenId
    ) external view returns (bool) {
        return _auctionIdByToken[tokenContract][tokenId] != 0;
    }

    /// @notice Minimum next bid in wei, paired with an existence flag so
    ///         callers can disambiguate "no auction" from "minimum is zero".
    ///         Mirrors the exact logic createBid enforces, including the
    ///         1-wei floor on the bps increment.
    function getMinBidAmount(
        uint256 auctionId
    ) external view returns (bool exists, uint256 minBid) {
        Auction storage a = auctions[auctionId];
        if (a.tokenOwner == address(0)) return (false, 0);
        if (a.amount == 0) return (true, a.reservePrice);
        uint256 increment = (a.amount * MIN_BID_INCREMENT_BPS) / 10000;
        if (increment == 0) increment = 1;
        return (true, a.amount + increment);
    }

    /// @notice Auction id that will be assigned to the next createAuction
    ///         call. Useful for clients that want to pre-compute the id
    ///         before broadcasting the tx.
    function nextAuctionId() external view returns (uint256) {
        return _nextAuctionId;
    }

    // ─── Internal ───────────────────────────────────────────────────────────

    /// @dev Push ETH to `to` if possible; if the recipient rejects, credit
    ///      a withdrawable balance instead. Used for bid refunds, protocol
    ///      fees, and seller payouts so a single failing recipient never
    ///      bricks the auction's settlement.
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

    function _exists(uint256 auctionId) internal view returns (bool) {
        return auctions[auctionId].tokenOwner != address(0);
    }

    /// @notice Reject direct ETH sends. Selfdestruct/coinbase forced ETH
    ///         bypasses this; outside our control.
    receive() external payable {
        revert("Direct ETH not accepted");
    }
}
