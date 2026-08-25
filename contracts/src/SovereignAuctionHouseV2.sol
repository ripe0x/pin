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

/// @title Sovereign Auction House V2
/// @notice ERC721 reserve auctions with a terminal bidder-refund outcome when
///         delivery cannot be verified. V1 clones are immutable and remain
///         governed by their original implementation.
contract SovereignAuctionHouseV2 is
    ISovereignAuctionHouseV2,
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
    error ContractBidderNotSupported();
    error EscrowFailed();
    error DeliveryFailed();
    error FailedDeliveryDoesNotExist();
    error FundsRecipientRequired();
    error OnlySelf();
    error OwnershipLocked();

    mapping(uint256 => Auction) public auctions;
    mapping(uint256 => FailedDelivery) public failedDeliveries;
    mapping(uint256 => uint64) public listingExpiry;

    // Active and failed lots deliberately have separate indexes. A failed lot
    // cannot be recovered through the owner-controlled stuck-token escape hatch.
    mapping(address => mapping(uint256 => uint256)) private _auctionIdByToken;
    mapping(address => mapping(uint256 => uint256)) private _failedAuctionIdByToken;
    mapping(address => uint256) public pendingRefunds;

    uint16 public protocolFeeBps;
    address payable public feeRecipient;
    uint256 private _nextAuctionId;

    // A safe ERC1155 transfer invokes the receiver. Bind that callback to the
    // exact pull underway so an unrelated token cannot be sent into custody.
    address private _pull1155Token;
    uint256 private _pull1155Id;
    uint256 private _pull1155Quantity;

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
        uint256 reservePrice
    ) external override nonReentrant onlyOwner returns (uint256) {
        return _createAuction(tokenId, tokenContract, duration, reservePrice);
    }

    function bulkCreateAuctions(
        address tokenContract,
        uint256[] calldata tokenIds,
        uint256 reservePrice,
        uint256 duration
    ) external nonReentrant onlyOwner returns (uint256[] memory auctionIds) {
        auctionIds = new uint256[](tokenIds.length);
        for (uint256 i; i < tokenIds.length; ++i) {
            auctionIds[i] = _createAuction(tokenIds[i], tokenContract, duration, reservePrice);
        }
    }

    function _createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice
    ) internal returns (uint256 auctionId) {
        require(IERC165(tokenContract).supportsInterface(ERC721_INTERFACE_ID), "tokenContract is not ERC721");
        _validateDuration(duration);
        if (_auctionIdByToken[tokenContract][tokenId] != 0 || _failedAuctionIdByToken[tokenContract][tokenId] != 0) {
            revert AuctionAlreadyExistsForToken();
        }

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

        IERC721(tokenContract).transferFrom(tokenOwner, address(this), tokenId);
        if (IERC721(tokenContract).ownerOf(tokenId) != address(this)) revert EscrowFailed();

        emit AuctionCreated(
            auctionId,
            tokenId,
            tokenContract,
            duration,
            reservePrice,
            tokenOwner,
            tokenOwner
        );
    }

    /// @notice Escrows one indivisible ERC1155 lot. Unlike ERC721, ERC1155
    ///         has no ownerOf, so only this house's owner may list its balance.
    function create1155Auction(
        uint256 tokenId,
        address tokenContract,
        uint256 quantity,
        uint256 duration,
        uint256 reservePrice
    ) external override onlyOwner nonReentrant returns (uint256 auctionId) {
        require(IERC165(tokenContract).supportsInterface(ERC1155_INTERFACE_ID), "tokenContract is not ERC1155");
        require(quantity != 0, "quantity zero");
        _validateDuration(duration);
        if (_auctionIdByToken[tokenContract][tokenId] != 0 || _failedAuctionIdByToken[tokenContract][tokenId] != 0) {
            revert AuctionAlreadyExistsForToken();
        }
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
        _pull1155(tokenContract, tokenId, quantity, msg.sender);
        emit Auction1155Created(auctionId, tokenId, tokenContract, quantity, duration, reservePrice, msg.sender, msg.sender);
    }

    function setAuctionReservePrice(uint256 auctionId, uint256 reservePrice)
        external
        override
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
        // An ERC1155 safe transfer gives a contract winner control over
        // receipt. Exclude contract wallets only for those lots, otherwise a
        // winner could reject delivery and deliberately choose a refund.
        if (a.standard == TokenStandard.ERC1155 && (msg.sender != tx.origin || msg.sender.code.length != 0)) {
            revert ContractBidderNotSupported();
        }
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
        if (firstBid) {
            a.firstBidTime = uint64(block.timestamp);
            a.endTime = uint64(block.timestamp + a.duration);
        } else {
            _sendOrCredit(lastBidder, a.amount);
        }
        a.amount = amount;
        a.bidder = payable(msg.sender);

        bool extended;
        if (a.endTime - block.timestamp < TIME_BUFFER) {
            a.endTime = uint64(block.timestamp + TIME_BUFFER);
            extended = true;
        }
        emit AuctionBid(auctionId, msg.sender, amount, firstBid, extended);
        if (extended) emit AuctionEndTimeUpdated(auctionId, a.endTime);
    }

    /// @notice Resolves every ended auction. A successful result proves the
    ///         winner owns the token before any seller or protocol payout.
    ///         A failed result credits the full gross bid to the winner and
    ///         retains the lot solely for return to its original owner.
    function endAuction(uint256 auctionId)
        external
        override
        auctionExists(auctionId)
        nonReentrant
    {
        Auction memory a = auctions[auctionId];
        if (a.firstBidTime == 0) revert AuctionHasNoBids();
        if (block.timestamp < a.endTime) revert AuctionNotEnded();

        if (a.standard == TokenStandard.ERC721) {
            try this.deliverERC721(a.tokenContract, a.tokenId, a.bidder) {
                _settleVerifiedDelivery(auctionId, a);
            } catch {
                _recordFailedDelivery(auctionId, a);
            }
        } else {
            try this.deliverERC1155(a.tokenContract, a.tokenId, a.quantity, a.bidder) {
                _settleVerifiedDelivery(auctionId, a);
            } catch {
                _recordFailedDelivery(auctionId, a);
            }
        }
    }

    /// @dev Must be a separate external call so both transfer and ownerOf
    ///      verification are rolled back before the outer refund commits.
    function deliverERC721(address tokenContract, uint256 tokenId, address winner) external {
        if (msg.sender != address(this)) revert OnlySelf();
        IERC721(tokenContract).transferFrom(address(this), winner, tokenId);
        if (IERC721(tokenContract).ownerOf(tokenId) != winner) revert DeliveryFailed();
    }

    function deliverERC1155(address tokenContract, uint256 tokenId, uint256 quantity, address winner) external {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 beforeBalance = IERC1155(tokenContract).balanceOf(winner, tokenId);
        IERC1155(tokenContract).safeTransferFrom(address(this), winner, tokenId, quantity, "");
        if (IERC1155(tokenContract).balanceOf(winner, tokenId) < beforeBalance + quantity) revert DeliveryFailed();
    }

    function _settleVerifiedDelivery(uint256 auctionId, Auction memory a) internal {
        uint256 protocolFee;
        if (protocolFeeBps != 0) {
            protocolFee = (a.amount * protocolFeeBps) / 10_000;
            _sendOrCredit(feeRecipient, protocolFee);
        }
        uint256 sellerProceeds = a.amount - protocolFee;
        _sendOrCredit(a.fundsRecipient, sellerProceeds);
        emit AuctionEnded(auctionId, a.tokenOwner, a.bidder, sellerProceeds, protocolFee);
        delete _auctionIdByToken[a.tokenContract][a.tokenId];
        delete auctions[auctionId];
        delete listingExpiry[auctionId];
    }

    function _recordFailedDelivery(uint256 auctionId, Auction memory a) internal {
        pendingRefunds[a.bidder] += a.amount;
        failedDeliveries[auctionId] = FailedDelivery({
            tokenContract: a.tokenContract,
            tokenId: a.tokenId,
            tokenOwner: a.tokenOwner,
            quantity: a.quantity,
            standard: a.standard
        });
        delete _auctionIdByToken[a.tokenContract][a.tokenId];
        _failedAuctionIdByToken[a.tokenContract][a.tokenId] = auctionId + 1;
        delete auctions[auctionId];
        delete listingExpiry[auctionId];
        emit RefundCredited(a.bidder, a.amount);
        emit AuctionDeliveryFailed(auctionId, a.bidder, a.amount);
    }

    /// @notice Permissionless retry of a failed lot, but it can only ever go
    ///         to the original token owner and has no effect on bidder funds.
    function claimFailedLot(uint256 auctionId) external override nonReentrant {
        FailedDelivery memory failed = failedDeliveries[auctionId];
        if (failed.tokenOwner == address(0)) revert FailedDeliveryDoesNotExist();
        if (failed.standard == TokenStandard.ERC721) {
            IERC721(failed.tokenContract).transferFrom(address(this), failed.tokenOwner, failed.tokenId);
            if (IERC721(failed.tokenContract).ownerOf(failed.tokenId) != failed.tokenOwner) revert DeliveryFailed();
        } else {
            uint256 beforeBalance = IERC1155(failed.tokenContract).balanceOf(failed.tokenOwner, failed.tokenId);
            IERC1155(failed.tokenContract).safeTransferFrom(
                address(this), failed.tokenOwner, failed.tokenId, failed.quantity, ""
            );
            if (IERC1155(failed.tokenContract).balanceOf(failed.tokenOwner, failed.tokenId) < beforeBalance + failed.quantity) {
                revert DeliveryFailed();
            }
        }
        delete _failedAuctionIdByToken[failed.tokenContract][failed.tokenId];
        delete failedDeliveries[auctionId];
        emit FailedLotReturned(auctionId, failed.tokenOwner);
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
        if (a.standard == TokenStandard.ERC721) {
            IERC721(a.tokenContract).transferFrom(address(this), a.tokenOwner, a.tokenId);
            if (IERC721(a.tokenContract).ownerOf(a.tokenId) != a.tokenOwner) revert DeliveryFailed();
        } else {
            uint256 beforeBalance = IERC1155(a.tokenContract).balanceOf(a.tokenOwner, a.tokenId);
            IERC1155(a.tokenContract).safeTransferFrom(address(this), a.tokenOwner, a.tokenId, a.quantity, "");
            if (IERC1155(a.tokenContract).balanceOf(a.tokenOwner, a.tokenId) < beforeBalance + a.quantity) {
                revert DeliveryFailed();
            }
        }
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
        if (a.standard == TokenStandard.ERC721) {
            IERC721(a.tokenContract).transferFrom(address(this), a.tokenOwner, a.tokenId);
            if (IERC721(a.tokenContract).ownerOf(a.tokenId) != a.tokenOwner) revert DeliveryFailed();
        } else {
            uint256 beforeBalance = IERC1155(a.tokenContract).balanceOf(a.tokenOwner, a.tokenId);
            IERC1155(a.tokenContract).safeTransferFrom(address(this), a.tokenOwner, a.tokenId, a.quantity, "");
            if (IERC1155(a.tokenContract).balanceOf(a.tokenOwner, a.tokenId) < beforeBalance + a.quantity) {
                revert DeliveryFailed();
            }
        }
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
        if (_auctionIdByToken[tokenContract][tokenId] != 0 || _failedAuctionIdByToken[tokenContract][tokenId] != 0) {
            revert AuctionAlreadyExistsForToken();
        }
        IERC721(tokenContract).transferFrom(address(this), to, tokenId);
        emit StuckERC721Recovered(tokenContract, tokenId, to);
    }

    function recoverStuckERC1155(address tokenContract, uint256 tokenId, uint256 quantity, address to)
        external
        onlyOwner
        nonReentrant
    {
        require(to != address(0), "to required");
        if (_auctionIdByToken[tokenContract][tokenId] != 0 || _failedAuctionIdByToken[tokenContract][tokenId] != 0) {
            revert AuctionAlreadyExistsForToken();
        }
        IERC1155(tokenContract).safeTransferFrom(address(this), to, tokenId, quantity, "");
    }

    function getAuctionFor(address tokenContract, uint256 tokenId) external view returns (bool exists, uint256 auctionId) {
        uint256 stored = _auctionIdByToken[tokenContract][tokenId];
        return stored == 0 ? (false, 0) : (true, stored - 1);
    }

    function getFailedAuctionFor(address tokenContract, uint256 tokenId) external view returns (bool exists, uint256 auctionId) {
        uint256 stored = _failedAuctionIdByToken[tokenContract][tokenId];
        return stored == 0 ? (false, 0) : (true, stored - 1);
    }

    function nextAuctionId() external view returns (uint256) {
        return _nextAuctionId;
    }

    /// @notice Distinguishes V2 tuple layout from the immutable V1 ABI.
    function auctionVersion() external pure returns (uint8) {
        return 2;
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

    function _sendOrCredit(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool sent,) = to.call{value: amount, gas: 30_000}("");
        if (!sent) {
            pendingRefunds[to] += amount;
            emit RefundCredited(to, amount);
        }
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
