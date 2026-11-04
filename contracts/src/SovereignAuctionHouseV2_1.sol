// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "openzeppelin-contracts/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";

import {ISovereignAuctionHouseV2} from "./ISovereignAuctionHouseV2.sol";
import {ISovereignAuctionHouseV2_1} from "./ISovereignAuctionHouseV2_1.sol";

/// @title Sovereign Auction House V2.1
/// @notice ERC721 and ERC1155 reserve auctions. Same ABI, storage layout and
///         `Auction` tuple as SovereignAuctionHouseV2, with one change to
///         how a failed delivery is resolved.
///
///         endAuction attempts delivery to the winner through a try/catch
///         self-call capped at DELIVER_GAS_LIMIT. If it succeeds, the sale
///         finalizes exactly as in V2. If it fails, the house asks a second
///         question with a capped probe: can the lot be transferred out of
///         escrow to a fresh, codeless address (DELIVERY_PROBE_RECIPIENT)?
///         The probe performs that transfer, verifies it, and then always
///         reverts, so no state survives it.
///
///         - Lot transferable: the failure is specific to the winner's
///           address (a receiver hook that rejects, a recipient-specific
///           token policy). The sale is binding. The protocol fee and seller
///           are paid, and the lot stays escrowed for the winner
///           (heldForWinner), who may claim it at any time, to any address
///           it chooses, with no deadline. No refund path exists from here.
///         - Lot not transferable (paused or locked collection, burned or
///           tampered escrow, a transfer that needs more than the stipend):
///           V2 behaviour. Nobody is paid, the lot is pendingDelivery and
///           anyone may retry through claimLot. unwindStuckLot may be
///           called at any time: it retries the winner, then re-runs the
///           probe and settles for the winner if the lot has become
///           transferable. Only once PENDING_DELIVERY_TIMEOUT has passed,
///           and only if the lot still cannot move, does it refund the
///           winner's full bid and attempt to return the lot to the seller.
///
///         Whoever controls the token contract's transfer policy decides
///         which branch applies. A seller (or anyone else) who controls the
///         collection can block all transfers after the hammer, wait out
///         PENDING_DELIVERY_TIMEOUT and have the sale unwound: the winner is
///         refunded in full, its bid is locked for that period, and the lot
///         returns to the seller. This is the cost of refunding a winner
///         whose lot genuinely cannot move, and it cannot be told apart from
///         a real pause on-chain. Bidders on lots from collections whose
///         transfers can be paused or restricted by an interested party
///         accept that risk.
contract SovereignAuctionHouseV2_1 is
    ISovereignAuctionHouseV2_1,
    IERC1155Receiver,
    Initializable,
    ReentrancyGuard,
    OwnableUpgradeable
{
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;
    bytes4 private constant ERC1155_INTERFACE_ID = 0xd9b67a26;

    uint256 public constant TIME_BUFFER = 15 minutes;
    uint16 public constant MIN_BID_INCREMENT_BPS = 500;
    uint256 public constant MAX_DURATION = 365 days * 100;

    error AuctionDoesNotExist();
    error AuctionAlreadyStarted();
    error AuctionExpired();
    error AuctionNotEnded();
    error AuctionHasNoBids();
    error AuctionAlreadyExistsForToken();
    error BidBelowReserve();
    error BidBelowMinimum();
    error BidMustBePositive();
    error EscrowFailed();
    error DeliveryFailed();
    error FundsRecipientRequired();
    error OnlySelf();
    error OwnershipLocked();
    error AuctionAlreadySettled();
    error NoPendingDelivery();
    error NoPendingReturn();
    error NotWinner();
    error InsufficientGas();
    error UnwindTooEarly();
    /// @dev Revert payload of probeTransfer when the probe transfer and its
    ///      verification both succeeded. Only probeTransfer's own code can
    ///      produce it: every token call inside the probe is wrapped in
    ///      try/catch, so no token revert payload can reach the caller.
    error LotTransferable();
    /// @dev Revert payload of probeTransfer when the lot could not be moved.
    error LotNotTransferable();

    uint256 internal constant DELIVER_GAS_LIMIT = 500_000;

    /// @dev Headroom required before every capped self-call. EIP-150
    ///      forwards at most 63/64 of the remaining gas, so without it a
    ///      gas-starved caller could hand a delivery or probe less than
    ///      DELIVER_GAS_LIMIT and have a transfer that would have succeeded
    ///      classified as a failure.
    uint256 internal constant CAPPED_CALL_HEADROOM = DELIVER_GAS_LIMIT + 80_000;

    /// @notice A deferred lot that still cannot be transferred this long
    ///         after deferral becomes eligible for a refund through
    ///         unwindStuckLot.
    uint64 public constant PENDING_DELIVERY_TIMEOUT = 30 days;

    /// @notice Recipient used by the transferability probe. Derived from a
    ///         hash, so no private key or deployable code is known for it,
    ///         and it has no receiver hook. The probe's transfer to it is
    ///         always reverted; no token ever rests here.
    address public constant DELIVERY_PROBE_RECIPIENT =
        address(uint160(uint256(keccak256("pnd.sovereign-auction-house.v2_1.delivery-probe"))));

    mapping(uint256 => Auction) public auctions;
    mapping(uint256 => uint64) public listingExpiry;

    /// @notice True for an auction whose delivery failed while the lot also
    ///         could not be transferred out of escrow. Neither the seller
    ///         nor the protocol fee has been paid; the winning bid is still
    ///         escrowed. Resolved by claimLot or unwindStuckLot.
    mapping(uint256 => bool) public pendingDelivery;

    /// @notice Timestamp a lot entered pendingDelivery, keyed by auctionId.
    mapping(uint256 => uint64) public deliveryDeferredAt;

    /// @notice True for an auction that unwindStuckLot refunded but whose
    ///         lot return to the seller failed. The lot stays locked until
    ///         returnUnwoundLot delivers it to the seller.
    mapping(uint256 => bool) public pendingReturn;

    // A settled-but-undelivered lot keeps its entry here, which blocks a
    // duplicate listing and stuck-token recovery for the same token until
    // claimLot, unwindStuckLot, or returnUnwoundLot clears it.
    mapping(address => mapping(uint256 => uint256)) private _auctionIdByToken;
    mapping(address => uint256) public pendingRefunds;

    uint16 public protocolFeeBps;
    address payable public feeRecipient;
    uint256 private _nextAuctionId;

    // A safe ERC1155 transfer invokes the receiver. Bind that callback to the
    // exact pull underway so an unrelated token cannot be sent into custody.
    address private _pull1155Token;
    uint256 private _pull1155Id;
    uint256 private _pull1155Quantity;

    /// @inheritdoc ISovereignAuctionHouseV2_1
    mapping(uint256 => bool) public heldForWinner;

    modifier auctionExists(uint256 auctionId) {
        if (!_exists(auctionId)) revert AuctionDoesNotExist();
        _;
    }

    constructor() {
        _disableInitializers();
    }

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
    }

    function transferOwnership(address) public pure override {
        revert OwnershipLocked();
    }

    function renounceOwnership() public pure override {
        revert OwnershipLocked();
    }

    function createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice,
        uint64 listingExpiry_
    ) external override nonReentrant onlyOwner returns (uint256) {
        return _createAuction(tokenId, tokenContract, duration, reservePrice, listingExpiry_);
    }

    /// @notice One listingExpiry_ applies to every auction created in the batch.
    function bulkCreateAuctions(
        address tokenContract,
        uint256[] calldata tokenIds,
        uint256 reservePrice,
        uint256 duration,
        uint64 listingExpiry_
    ) external nonReentrant onlyOwner returns (uint256[] memory auctionIds) {
        auctionIds = new uint256[](tokenIds.length);
        for (uint256 i; i < tokenIds.length; ++i) {
            auctionIds[i] = _createAuction(tokenIds[i], tokenContract, duration, reservePrice, listingExpiry_);
        }
    }

    function _createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice,
        uint64 listingExpiry_
    ) internal returns (uint256 auctionId) {
        require(IERC165(tokenContract).supportsInterface(ERC721_INTERFACE_ID), "tokenContract is not ERC721");
        _validateDuration(duration);
        require(listingExpiry_ == 0 || listingExpiry_ > block.timestamp, "expiry must be future");
        if (_auctionIdByToken[tokenContract][tokenId] != 0) revert AuctionAlreadyExistsForToken();

        address tokenOwner = IERC721(tokenContract).ownerOf(tokenId);
        require(
            msg.sender == tokenOwner ||
                msg.sender == IERC721(tokenContract).getApproved(tokenId) ||
                IERC721(tokenContract).isApprovedForAll(tokenOwner, msg.sender),
            "Not token owner or approved"
        );

        auctionId = _nextAuctionId++;
        auctions[auctionId] = Auction({
            tokenId: tokenId,
            tokenContract: tokenContract,
            firstBidTime: 0,
            amount: 0,
            reservePrice: reservePrice,
            tokenOwner: tokenOwner,
            fundsRecipient: payable(tokenOwner),
            endTime: 0,
            bidder: payable(address(0)),
            duration: uint64(duration),
            quantity: 1,
            standard: TokenStandard.ERC721
        });
        _auctionIdByToken[tokenContract][tokenId] = auctionId + 1;
        if (listingExpiry_ != 0) listingExpiry[auctionId] = listingExpiry_;

        IERC721(tokenContract).transferFrom(tokenOwner, address(this), tokenId);
        if (IERC721(tokenContract).ownerOf(tokenId) != address(this)) revert EscrowFailed();

        emit AuctionCreated(
            auctionId,
            tokenId,
            tokenContract,
            duration,
            reservePrice,
            tokenOwner,
            tokenOwner,
            listingExpiry_
        );
    }

    /// @notice Escrows one indivisible ERC1155 lot. Unlike ERC721, ERC1155
    ///         has no ownerOf, so only this house's owner may list its balance.
    function create1155Auction(
        uint256 tokenId,
        address tokenContract,
        uint256 quantity,
        uint256 duration,
        uint256 reservePrice,
        uint64 listingExpiry_
    ) external override onlyOwner nonReentrant returns (uint256 auctionId) {
        require(IERC165(tokenContract).supportsInterface(ERC1155_INTERFACE_ID), "tokenContract is not ERC1155");
        require(quantity != 0, "quantity zero");
        _validateDuration(duration);
        require(listingExpiry_ == 0 || listingExpiry_ > block.timestamp, "expiry must be future");
        if (_auctionIdByToken[tokenContract][tokenId] != 0) revert AuctionAlreadyExistsForToken();
        require(IERC1155(tokenContract).balanceOf(msg.sender, tokenId) >= quantity, "insufficient balance");
        require(IERC1155(tokenContract).isApprovedForAll(msg.sender, address(this)), "house not approved");

        auctionId = _nextAuctionId++;
        auctions[auctionId] = Auction({
            tokenId: tokenId,
            tokenContract: tokenContract,
            firstBidTime: 0,
            amount: 0,
            reservePrice: reservePrice,
            tokenOwner: msg.sender,
            fundsRecipient: payable(msg.sender),
            endTime: 0,
            bidder: payable(address(0)),
            duration: uint64(duration),
            quantity: quantity,
            standard: TokenStandard.ERC1155
        });
        _auctionIdByToken[tokenContract][tokenId] = auctionId + 1;
        if (listingExpiry_ != 0) listingExpiry[auctionId] = listingExpiry_;
        _pull1155(tokenContract, tokenId, quantity, msg.sender);
        emit Auction1155Created(
            auctionId, tokenId, tokenContract, quantity, duration, reservePrice, msg.sender, msg.sender, listingExpiry_
        );
    }

    function setAuctionReservePrice(uint256 auctionId, uint256 reservePrice)
        external
        override
        nonReentrant
        auctionExists(auctionId)
    {
        Auction storage a = auctions[auctionId];
        require(msg.sender == a.tokenOwner, "Not token owner");
        if (a.firstBidTime != 0) revert AuctionAlreadyStarted();
        a.reservePrice = reservePrice;
        emit AuctionReservePriceUpdated(auctionId, reservePrice);
    }

    /// @notice Lets the captured NFT owner choose any bounded duration before
    ///         bidding starts. The duration is immutable once a bid lands.
    function setAuctionDuration(uint256 auctionId, uint256 duration)
        external
        override
        nonReentrant
        auctionExists(auctionId)
    {
        Auction storage a = auctions[auctionId];
        require(msg.sender == a.tokenOwner, "Not token owner");
        if (a.firstBidTime != 0) revert AuctionAlreadyStarted();
        _validateDuration(duration);
        a.duration = uint64(duration);
        emit AuctionDurationUpdated(auctionId, duration);
    }

    /// @notice Direct sale proceeds before bidding starts. An approved house
    ///         owner cannot redirect a third-party token owner's proceeds.
    function setAuctionFundsRecipient(uint256 auctionId, address payable fundsRecipient)
        external
        override
        nonReentrant
        auctionExists(auctionId)
    {
        Auction storage a = auctions[auctionId];
        require(msg.sender == a.tokenOwner, "Not token owner");
        if (a.firstBidTime != 0) revert AuctionAlreadyStarted();
        if (fundsRecipient == address(0)) revert FundsRecipientRequired();
        a.fundsRecipient = fundsRecipient;
        emit AuctionFundsRecipientUpdated(auctionId, fundsRecipient);
    }

    /// @notice Optionally lets the captured owner set a no-bid listing expiry.
    ///         Zero means the listing stays open until canceled by its owner.
    function setAuctionListingExpiry(uint256 auctionId, uint64 expiry)
        external
        override
        nonReentrant
        auctionExists(auctionId)
    {
        Auction storage a = auctions[auctionId];
        require(msg.sender == a.tokenOwner, "Not token owner");
        if (a.firstBidTime != 0) revert AuctionAlreadyStarted();
        require(expiry == 0 || expiry > block.timestamp, "expiry must be future");
        listingExpiry[auctionId] = expiry;
        emit AuctionListingExpiryUpdated(auctionId, expiry);
    }

    function createBid(uint256 auctionId)
        external
        payable
        override
        auctionExists(auctionId)
        nonReentrant
    {
        Auction storage a = auctions[auctionId];
        uint64 expiry = listingExpiry[auctionId];
        if (a.firstBidTime == 0 && expiry != 0 && block.timestamp >= expiry) revert AuctionExpired();
        uint256 amount = msg.value;
        if (amount == 0) revert BidMustBePositive();
        if (a.firstBidTime != 0 && block.timestamp >= a.endTime) revert AuctionExpired();
        if (amount < a.reservePrice) revert BidBelowReserve();
        if (a.amount != 0) {
            uint256 increment = (a.amount * MIN_BID_INCREMENT_BPS) / 10_000;
            if (increment == 0) increment = 1;
            if (amount < a.amount + increment) revert BidBelowMinimum();
        }

        bool firstBid = a.firstBidTime == 0;
        address payable lastBidder = a.bidder;
        uint256 previousAmount = a.amount;
        if (firstBid) {
            a.firstBidTime = uint64(block.timestamp);
            a.endTime = uint64(block.timestamp + a.duration);
        }
        a.amount = amount;
        a.bidder = payable(msg.sender);
        if (!firstBid) {
            _sendOrCredit(lastBidder, previousAmount);
        }

        bool extended;
        if (a.endTime - block.timestamp < TIME_BUFFER) {
            a.endTime = uint64(block.timestamp + TIME_BUFFER);
            extended = true;
        }
        emit AuctionBid(auctionId, msg.sender, amount, firstBid, extended);
        if (extended) emit AuctionEndTimeUpdated(auctionId, a.endTime);
    }

    /// @notice Resolves an ended auction with bids. Delivery to the winner
    ///         is attempted through a capped try/catch self-call, so the
    ///         outcome cannot depend on caller-supplied gas.
    ///         - Delivered: the protocol fee and seller are paid
    ///           (AuctionEnded).
    ///         - Not delivered, lot transferable: the sale settles and the
    ///           lot is held for the winner (AuctionEnded, LotHeldForWinner).
    ///         - Not delivered, lot not transferable: nobody is paid and the
    ///           lot is deferred (DeliveryDeferred), as in V2.
    ///         Reverts with InsufficientGas, changing nothing, whenever the
    ///         remaining gas could not honour a capped call's full stipend.
    function endAuction(uint256 auctionId)
        external
        override
        auctionExists(auctionId)
        nonReentrant
    {
        Auction memory a = auctions[auctionId];
        if (a.firstBidTime == 0) revert AuctionHasNoBids();
        if (block.timestamp < a.endTime) revert AuctionNotEnded();
        if (pendingDelivery[auctionId] || pendingReturn[auctionId] || heldForWinner[auctionId]) {
            revert AuctionAlreadySettled();
        }

        if (_tryDeliver(a, a.bidder)) {
            _finalizeSale(auctionId, a);
        } else if (_lotTransferable(a)) {
            _settleHeldForWinner(auctionId, a);
        } else {
            pendingDelivery[auctionId] = true;
            deliveryDeferredAt[auctionId] = uint64(block.timestamp);
            emit DeliveryDeferred(auctionId, a.bidder);
        }
    }

    /// @dev Runs only once delivery has been verified. Deletes all per-lot
    ///      storage first, then pays the protocol fee and seller.
    function _finalizeSale(uint256 auctionId, Auction memory a) internal {
        delete auctions[auctionId];
        delete _auctionIdByToken[a.tokenContract][a.tokenId];
        delete listingExpiry[auctionId];
        delete pendingDelivery[auctionId];
        delete deliveryDeferredAt[auctionId];
        delete pendingReturn[auctionId];
        _paySale(auctionId, a);
    }

    /// @dev Settles a sale whose lot is transferable but could not reach the
    ///      winner. The auction record and token index stay in storage so
    ///      the lot stays locked to this auction (no relisting, no
    ///      recoverStuck*), and claimLot can later deliver it. State is
    ///      written before the payout; _payout never calls contract code.
    function _settleHeldForWinner(uint256 auctionId, Auction memory a) internal {
        delete listingExpiry[auctionId];
        delete pendingDelivery[auctionId];
        delete deliveryDeferredAt[auctionId];
        heldForWinner[auctionId] = true;
        _paySale(auctionId, a);
        emit LotHeldForWinner(auctionId, a.bidder);
    }

    function _paySale(uint256 auctionId, Auction memory a) internal {
        uint256 protocolFee;
        if (protocolFeeBps != 0) {
            protocolFee = (a.amount * protocolFeeBps) / 10_000;
            _payout(feeRecipient, protocolFee);
        }
        uint256 sellerProceeds = a.amount - protocolFee;
        _payout(a.fundsRecipient, sellerProceeds);
        emit AuctionEnded(auctionId, a.tokenOwner, a.bidder, sellerProceeds, protocolFee);
    }

    /// @dev Delivery target for the capped try/catch self-calls. `to` is the
    ///      winner (endAuction, unwindStuckLot's retry) or the seller
    ///      (unwindStuckLot's return). Reverting here rolls back the
    ///      transfer and its verification together.
    function deliverERC721(address tokenContract, uint256 tokenId, address to) external {
        if (msg.sender != address(this)) revert OnlySelf();
        IERC721(tokenContract).transferFrom(address(this), to, tokenId);
        if (IERC721(tokenContract).ownerOf(tokenId) != to) revert DeliveryFailed();
    }

    function deliverERC1155(address tokenContract, uint256 tokenId, uint256 quantity, address to) external {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 beforeBalance = IERC1155(tokenContract).balanceOf(to, tokenId);
        IERC1155(tokenContract).safeTransferFrom(address(this), to, tokenId, quantity, "");
        if (IERC1155(tokenContract).balanceOf(to, tokenId) < beforeBalance + quantity) revert DeliveryFailed();
    }

    /// @dev Transferability probe, reachable only through _lotTransferable's
    ///      capped self-call. Moves the lot to DELIVERY_PROBE_RECIPIENT,
    ///      verifies the move, and always reverts, so neither the transfer
    ///      nor anything the token did during it survives. Every token call
    ///      is wrapped in try/catch, so the only way to produce the
    ///      LotTransferable payload is a verified transfer.
    function probeTransfer(address tokenContract, uint256 tokenId, uint256 quantity, TokenStandard standard)
        external
    {
        if (msg.sender != address(this)) revert OnlySelf();
        address to = DELIVERY_PROBE_RECIPIENT;
        bool moved;
        if (standard == TokenStandard.ERC721) {
            try IERC721(tokenContract).transferFrom(address(this), to, tokenId) {
                try IERC721(tokenContract).ownerOf(tokenId) returns (address owner) {
                    moved = owner == to;
                } catch {}
            } catch {}
        } else {
            try IERC1155(tokenContract).balanceOf(to, tokenId) returns (uint256 before) {
                try IERC1155(tokenContract).safeTransferFrom(address(this), to, tokenId, quantity, "") {
                    try IERC1155(tokenContract).balanceOf(to, tokenId) returns (uint256 got) {
                        moved = got >= before && got - before >= quantity;
                    } catch {}
                } catch {}
            } catch {}
        }
        if (moved) revert LotTransferable();
        revert LotNotTransferable();
    }

    /// @notice Claims a lot that has not yet reached the winner: either a
    ///         settled sale held for the winner (heldForWinner) or a lot
    ///         whose delivery was deferred unpaid (pendingDelivery). Anyone
    ///         may call with `to == address(0)` to deliver to the recorded
    ///         winner; only the winner may name another recipient. Runs with
    ///         full gas and no try/catch, so a failed transfer reverts the
    ///         whole call and leaves the claim retryable.
    ///         For a held lot the seller has already been paid; this call
    ///         only moves the lot. For a deferred lot the protocol fee and
    ///         seller are paid in this call, after delivery is verified.
    ///         A held lot has no deadline and no refund path. A third party
    ///         triggering delivery to the winner's own address consumes the
    ///         claim, so it forecloses a later redirect by the winner; the
    ///         lot still reaches the winner's bid address.
    function claimLot(uint256 auctionId, address to) external override nonReentrant {
        bool held = heldForWinner[auctionId];
        if (!held && !pendingDelivery[auctionId]) revert NoPendingDelivery();
        Auction memory a = auctions[auctionId];
        if (msg.sender != a.bidder && to != address(0)) revert NotWinner();

        address recipient = to == address(0) ? a.bidder : to;
        // Delivering to the house itself would leave the lot unindexed and
        // reachable by recoverStuck*.
        if (recipient == address(this)) revert DeliveryFailed();

        if (held) {
            delete heldForWinner[auctionId];
            delete auctions[auctionId];
            delete _auctionIdByToken[a.tokenContract][a.tokenId];
            _transferOut(a, recipient);
        } else {
            _transferOut(a, recipient);
            _finalizeSale(auctionId, a);
        }
        emit LotClaimed(auctionId, a.bidder, recipient);
    }

    /// @notice Resolves a lot in pendingDelivery. Anyone may call this, at
    ///         any time. In order:
    ///         1. Retries capped delivery to the recorded winner. On success
    ///            the sale finalizes and the seller is paid (LotClaimed).
    ///         2. Otherwise re-runs the transferability probe. If the lot can
    ///            now move, the sale settles and the lot is held for the
    ///            winner (AuctionEnded, LotHeldForWinner); no refund.
    ///         3. Otherwise, before PENDING_DELIVERY_TIMEOUT has passed since
    ///            deferral, reverts UnwindTooEarly. After it, unwinds: the
    ///            winner's full bid is credited to pendingRefunds before any
    ///            token movement, and a capped attempt returns the lot to the
    ///            seller. If that return fails, the lot stays locked until
    ///            returnUnwoundLot succeeds.
    ///         A refund is therefore only reachable while the lot cannot be
    ///         transferred to any fresh address.
    /// @dev Up to three capped self-calls (retry, probe, return), each
    ///      behind its own headroom guard.
    function unwindStuckLot(uint256 auctionId) external nonReentrant auctionExists(auctionId) {
        if (!pendingDelivery[auctionId]) revert NoPendingDelivery();
        Auction memory a = auctions[auctionId];

        if (_tryDeliver(a, a.bidder)) {
            _finalizeSale(auctionId, a);
            emit LotClaimed(auctionId, a.bidder, a.bidder);
            return;
        }

        if (_lotTransferable(a)) {
            _settleHeldForWinner(auctionId, a);
            return;
        }

        if (block.timestamp <= deliveryDeferredAt[auctionId] + PENDING_DELIVERY_TIMEOUT) revert UnwindTooEarly();

        delete pendingDelivery[auctionId];
        delete deliveryDeferredAt[auctionId];

        // Credited before any token movement is attempted: the winner's
        // refund never depends on whether the lot can be returned.
        pendingRefunds[a.bidder] += a.amount;
        emit RefundCredited(a.bidder, a.amount);

        if (_tryDeliver(a, a.tokenOwner)) {
            delete auctions[auctionId];
            delete _auctionIdByToken[a.tokenContract][a.tokenId];
            delete listingExpiry[auctionId];
        } else {
            pendingReturn[auctionId] = true;
            emit LotReturnDeferred(auctionId, a.tokenOwner);
        }

        emit LotUnwound(auctionId, a.bidder, a.amount, a.tokenOwner);
    }

    /// @notice Delivers a lot whose return to the seller failed during
    ///         unwindStuckLot. Anyone may call this; it only ever delivers to
    ///         the auction's recorded tokenOwner. Runs with full gas and no
    ///         try/catch, so a revert leaves the return retryable.
    function returnUnwoundLot(uint256 auctionId) external nonReentrant auctionExists(auctionId) {
        if (!pendingReturn[auctionId]) revert NoPendingReturn();
        Auction memory a = auctions[auctionId];

        _transferOut(a, a.tokenOwner);

        delete pendingReturn[auctionId];
        delete auctions[auctionId];
        delete _auctionIdByToken[a.tokenContract][a.tokenId];
        delete listingExpiry[auctionId];
        emit LotReturned(auctionId, a.tokenOwner);
    }

    function cancelAuction(uint256 auctionId)
        external
        override
        nonReentrant
        auctionExists(auctionId)
    {
        Auction memory a = auctions[auctionId];
        require(msg.sender == a.tokenOwner, "Not token owner");
        if (a.firstBidTime != 0) revert AuctionAlreadyStarted();
        _transferOut(a, a.tokenOwner);
        delete _auctionIdByToken[a.tokenContract][a.tokenId];
        delete auctions[auctionId];
        delete listingExpiry[auctionId];
        emit AuctionCanceled(auctionId);
    }

    /// @notice Anyone may clear a no-bid listing once its owner-selected
    ///         expiry has passed. The lot is always returned to that owner.
    function expireAuction(uint256 auctionId) external override nonReentrant auctionExists(auctionId) {
        Auction memory a = auctions[auctionId];
        uint64 expiry = listingExpiry[auctionId];
        if (a.firstBidTime != 0 || expiry == 0 || block.timestamp < expiry) revert AuctionNotEnded();
        _transferOut(a, a.tokenOwner);
        delete _auctionIdByToken[a.tokenContract][a.tokenId];
        delete auctions[auctionId];
        delete listingExpiry[auctionId];
        emit AuctionCanceled(auctionId);
    }

    function withdrawRefund() external override nonReentrant {
        _withdrawRefund(payable(msg.sender));
    }

    function withdrawRefundTo(address payable recipient) external override nonReentrant {
        if (recipient == address(0)) revert FundsRecipientRequired();
        _withdrawRefund(recipient);
    }

    function _withdrawRefund(address payable recipient) internal {
        uint256 amount = pendingRefunds[msg.sender];
        require(amount != 0, "No refund available");
        pendingRefunds[msg.sender] = 0;
        (bool sent,) = recipient.call{value: amount}("");
        require(sent, "Withdraw failed");
        emit RefundWithdrawn(msg.sender, recipient, amount);
    }

    function recoverStuckERC721(address tokenContract, uint256 tokenId, address to)
        external
        onlyOwner
        nonReentrant
    {
        require(to != address(0), "to required");
        if (_auctionIdByToken[tokenContract][tokenId] != 0) revert AuctionAlreadyExistsForToken();
        IERC721(tokenContract).transferFrom(address(this), to, tokenId);
        emit StuckERC721Recovered(tokenContract, tokenId, to);
    }

    function recoverStuckERC1155(address tokenContract, uint256 tokenId, uint256 quantity, address to)
        external
        onlyOwner
        nonReentrant
    {
        require(to != address(0), "to required");
        if (_auctionIdByToken[tokenContract][tokenId] != 0) revert AuctionAlreadyExistsForToken();
        uint256 beforeBalance = IERC1155(tokenContract).balanceOf(to, tokenId);
        IERC1155(tokenContract).safeTransferFrom(address(this), to, tokenId, quantity, "");
        if (IERC1155(tokenContract).balanceOf(to, tokenId) < beforeBalance + quantity) revert DeliveryFailed();
        emit StuckERC1155Recovered(tokenContract, tokenId, quantity, to);
    }

    /// @inheritdoc ISovereignAuctionHouseV2
    function getAuction(uint256 auctionId) external view override returns (Auction memory) {
        return auctions[auctionId];
    }

    function getAuctionFor(address tokenContract, uint256 tokenId) external view returns (bool exists, uint256 auctionId) {
        uint256 stored = _auctionIdByToken[tokenContract][tokenId];
        return stored == 0 ? (false, 0) : (true, stored - 1);
    }

    function nextAuctionId() external view returns (uint256) {
        return _nextAuctionId;
    }

    /// @notice Tuple-layout version shared with V2, so readers that select
    ///         the V2 ABI by this value keep working. Use version() to tell
    ///         V2.1 from V2.
    function auctionVersion() external pure returns (uint8) {
        return 2;
    }

    /// @inheritdoc ISovereignAuctionHouseV2_1
    function version() external pure returns (string memory) {
        return "2.1.0";
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function onERC1155Received(address, address, uint256 id, uint256 value, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != _pull1155Token || id != _pull1155Id || value != _pull1155Quantity) revert EscrowFailed();
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert EscrowFailed();
    }

    /// @dev Capped delivery attempt through deliverERC721/deliverERC1155.
    ///      Reverts InsufficientGas (changing nothing) rather than run the
    ///      attempt under its full stipend.
    function _tryDeliver(Auction memory a, address to) internal returns (bool delivered) {
        if (gasleft() < CAPPED_CALL_HEADROOM) revert InsufficientGas();
        if (a.standard == TokenStandard.ERC721) {
            try this.deliverERC721{gas: DELIVER_GAS_LIMIT}(a.tokenContract, a.tokenId, to) {
                delivered = true;
            } catch {}
        } else {
            try this.deliverERC1155{gas: DELIVER_GAS_LIMIT}(a.tokenContract, a.tokenId, a.quantity, to) {
                delivered = true;
            } catch {}
        }
    }

    /// @dev Runs probeTransfer in a capped self-call and reads at most four
    ///      bytes of its revert payload, so the probe's outcome costs the
    ///      same however much revert data the token produces. Reverts
    ///      InsufficientGas (changing nothing) rather than run the probe under
    ///      its full stipend.
    function _lotTransferable(Auction memory a) internal returns (bool transferable) {
        if (gasleft() < CAPPED_CALL_HEADROOM) revert InsufficientGas();
        bytes memory data = abi.encodeCall(this.probeTransfer, (a.tokenContract, a.tokenId, a.quantity, a.standard));
        bytes4 expected = LotTransferable.selector;
        assembly ("memory-safe") {
            let ok := call(DELIVER_GAS_LIMIT, address(), 0, add(data, 0x20), mload(data), 0, 0)
            if and(iszero(ok), eq(returndatasize(), 4)) {
                returndatacopy(0, 0, 4)
                transferable := eq(and(mload(0), shl(224, 0xffffffff)), expected)
            }
        }
    }

    /// @dev Full-gas transfer out of escrow with custody verification; any
    ///      failure reverts the calling transaction.
    function _transferOut(Auction memory a, address to) internal {
        if (a.standard == TokenStandard.ERC721) {
            IERC721(a.tokenContract).transferFrom(address(this), to, a.tokenId);
            if (IERC721(a.tokenContract).ownerOf(a.tokenId) != to) revert DeliveryFailed();
        } else {
            uint256 beforeBalance = IERC1155(a.tokenContract).balanceOf(to, a.tokenId);
            IERC1155(a.tokenContract).safeTransferFrom(address(this), to, a.tokenId, a.quantity, "");
            if (IERC1155(a.tokenContract).balanceOf(to, a.tokenId) < beforeBalance + a.quantity) {
                revert DeliveryFailed();
            }
        }
    }

    /// @dev Outbid-refund path in createBid only. Pushes with a 30_000 gas
    ///      stipend and credits pendingRefunds on failure.
    function _sendOrCredit(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool sent,) = to.call{value: amount, gas: 30_000}("");
        if (!sent) {
            pendingRefunds[to] += amount;
            emit RefundCredited(to, amount);
        }
    }

    /// @dev Seller-proceeds and protocol-fee payout. An EOA recipient (no
    ///      code) is pushed a 30_000 gas call; a contract recipient
    ///      (including an EIP-7702-delegated account) is never called and is
    ///      credited to pendingRefunds for a pull withdrawal.
    function _payout(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (to.code.length == 0) {
            (bool sent,) = to.call{value: amount, gas: 30_000}("");
            if (sent) return;
        }
        pendingRefunds[to] += amount;
        emit RefundCredited(to, amount);
    }

    function _pull1155(address tokenContract, uint256 tokenId, uint256 quantity, address from) internal {
        uint256 beforeBalance = IERC1155(tokenContract).balanceOf(address(this), tokenId);
        _pull1155Token = tokenContract;
        _pull1155Id = tokenId;
        _pull1155Quantity = quantity;
        IERC1155(tokenContract).safeTransferFrom(from, address(this), tokenId, quantity, "");
        _pull1155Token = address(0);
        _pull1155Id = 0;
        _pull1155Quantity = 0;
        if (IERC1155(tokenContract).balanceOf(address(this), tokenId) < beforeBalance + quantity) revert EscrowFailed();
    }

    function _validateDuration(uint256 duration) internal pure {
        require(duration != 0, "duration zero");
        require(duration <= MAX_DURATION, "duration too large");
    }

    function _exists(uint256 auctionId) internal view returns (bool) {
        return auctions[auctionId].tokenOwner != address(0);
    }

    receive() external payable {
        revert("Direct ETH not accepted");
    }
}
