// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

/// @title Sovereign Auction House V2 interface
/// @notice ETH reserve auctions for ERC721 and ERC1155 tokens. Settlement
///         pays the seller unconditionally; token delivery is attempted with
///         a fixed gas stipend and, on failure, deferred to a winner-only
///         claim. No sale ever unwinds.
interface ISovereignAuctionHouseV2 {
    enum TokenStandard {
        ERC721,
        ERC1155
    }

    struct Auction {
        uint256 tokenId;
        address tokenContract;
        uint64 firstBidTime;
        uint256 amount;
        uint256 reservePrice;
        address tokenOwner;
        address payable fundsRecipient;
        uint64 endTime;
        address payable bidder;
        uint64 duration;
        uint256 quantity;
        TokenStandard standard;
    }

    event AuctionCreated(
        uint256 indexed auctionId,
        uint256 indexed tokenId,
        address indexed tokenContract,
        uint256 duration,
        uint256 reservePrice,
        address tokenOwner,
        address fundsRecipient
    );
    event Auction1155Created(
        uint256 indexed auctionId,
        uint256 indexed tokenId,
        address indexed tokenContract,
        uint256 quantity,
        uint256 duration,
        uint256 reservePrice,
        address tokenOwner,
        address fundsRecipient
    );
    event AuctionReservePriceUpdated(uint256 indexed auctionId, uint256 reservePrice);
    event AuctionDurationUpdated(uint256 indexed auctionId, uint256 duration);
    event AuctionFundsRecipientUpdated(uint256 indexed auctionId, address fundsRecipient);
    event AuctionListingExpiryUpdated(uint256 indexed auctionId, uint64 listingExpiry);
    event AuctionBid(
        uint256 indexed auctionId,
        address indexed bidder,
        uint256 amount,
        bool firstBid,
        bool extended
    );
    event AuctionEndTimeUpdated(uint256 indexed auctionId, uint64 newEndTime);
    event AuctionEnded(
        uint256 indexed auctionId,
        address tokenOwner,
        address winner,
        uint256 sellerProceeds,
        uint256 protocolFee
    );
    /// @notice Emitted instead of, or in addition to, immediate delivery
    ///         when the token transfer attempted during endAuction fails.
    ///         The seller and protocol are already paid; the lot is claimable
    ///         by the winner via claimLot.
    event DeliveryDeferred(uint256 indexed auctionId, address indexed winner);
    /// @notice Emitted when claimLot delivers a deferred lot.
    event LotClaimed(uint256 indexed auctionId, address indexed winner, address recipient);
    event AuctionCanceled(uint256 indexed auctionId);
    event RefundCredited(address indexed to, uint256 amount);
    event RefundWithdrawn(address indexed account, address indexed recipient, uint256 amount);
    event StuckERC721Recovered(address indexed tokenContract, uint256 indexed tokenId, address to);

    function createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice
    ) external returns (uint256 auctionId);

    function create1155Auction(
        uint256 tokenId,
        address tokenContract,
        uint256 quantity,
        uint256 duration,
        uint256 reservePrice
    ) external returns (uint256 auctionId);

    function createBid(uint256 auctionId) external payable;

    /// @notice Settle a finished auction. Pays the protocol fee and seller
    ///         unconditionally, then attempts token delivery to the winner
    ///         with a fixed gas stipend so the outcome cannot depend on
    ///         caller-supplied gas. On delivery failure the payout still
    ///         happens; the lot is deferred to claimLot instead. Reverts if
    ///         the auction is already settled, or with InsufficientGas when
    ///         called without enough gas to honor the delivery stipend.
    function endAuction(uint256 auctionId) external;
    function cancelAuction(uint256 auctionId) external;
    function setAuctionReservePrice(uint256 auctionId, uint256 reservePrice) external;
    function setAuctionDuration(uint256 auctionId, uint256 duration) external;
    function setAuctionFundsRecipient(uint256 auctionId, address payable fundsRecipient) external;
    function setAuctionListingExpiry(uint256 auctionId, uint64 expiry) external;
    function expireAuction(uint256 auctionId) external;
    function withdrawRefund() external;
    function withdrawRefundTo(address payable recipient) external;

    /// @notice Winner-only claim for a lot whose delivery was deferred at
    ///         settlement. Delivers to msg.sender, or to `to` if nonzero.
    ///         Reverts if the auction has no deferred delivery or the caller
    ///         is not the recorded winner. A revert during delivery reverts
    ///         the whole call, leaving the claim retryable.
    function claimLot(uint256 auctionId, address to) external;
}
