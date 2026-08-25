// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

/// @title Sovereign Auction House V2 interface
/// @notice ETH reserve auctions for ERC721 tokens with verified delivery.
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

    struct FailedDelivery {
        address tokenContract;
        uint256 tokenId;
        address tokenOwner;
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
    event AuctionDeliveryFailed(
        uint256 indexed auctionId,
        address indexed winner,
        uint256 refundAmount
    );
    event FailedLotReturned(uint256 indexed auctionId, address indexed tokenOwner);
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
    function endAuction(uint256 auctionId) external;
    function cancelAuction(uint256 auctionId) external;
    function setAuctionReservePrice(uint256 auctionId, uint256 reservePrice) external;
    function setAuctionDuration(uint256 auctionId, uint256 duration) external;
    function setAuctionFundsRecipient(uint256 auctionId, address payable fundsRecipient) external;
    function setAuctionListingExpiry(uint256 auctionId, uint64 expiry) external;
    function expireAuction(uint256 auctionId) external;
    function withdrawRefund() external;
    function withdrawRefundTo(address payable recipient) external;
    function claimFailedLot(uint256 auctionId) external;
}
