// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

/// @title PND Auction House interface
/// @notice ETH-denominated reserve auctions for ERC721 tokens. Adapted from
///         Zora's AuctionHouse (audited 2021), ported to Solidity 0.8 and
///         restructured for the beacon-proxy + per-artist clone pattern.
interface IPndAuctionHouse {
    struct Auction {
        uint256 tokenId;
        address tokenContract;
        bool approved;
        uint256 amount;
        uint256 duration;
        uint256 firstBidTime;
        uint256 reservePrice;
        uint16 curatorFeeBps;
        address tokenOwner;
        address payable bidder;
        address payable curator;
    }

    event AuctionCreated(
        uint256 indexed auctionId,
        uint256 indexed tokenId,
        address indexed tokenContract,
        uint256 duration,
        uint256 reservePrice,
        address tokenOwner,
        address curator,
        uint16 curatorFeeBps
    );

    event AuctionApprovalUpdated(
        uint256 indexed auctionId,
        bool approved
    );

    event AuctionReservePriceUpdated(
        uint256 indexed auctionId,
        uint256 reservePrice
    );

    event AuctionBid(
        uint256 indexed auctionId,
        address indexed bidder,
        uint256 amount,
        bool firstBid,
        bool extended
    );

    event AuctionDurationExtended(
        uint256 indexed auctionId,
        uint256 newDuration
    );

    event AuctionEnded(
        uint256 indexed auctionId,
        address tokenOwner,
        address curator,
        address winner,
        uint256 sellerProceeds,
        uint256 curatorFee,
        uint256 protocolFee
    );

    event AuctionCanceled(uint256 indexed auctionId);

    event ProtocolFeeUpdated(uint16 newBps);
    event FeeRecipientUpdated(address newRecipient);
    event ProtocolFeeAdminUpdated(address newAdmin);
    event RefundCredited(address indexed to, uint256 amount);
    event RefundWithdrawn(address indexed to, uint256 amount);

    function createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice,
        address payable curator,
        uint16 curatorFeeBps
    ) external returns (uint256);

    function setAuctionApproval(uint256 auctionId, bool approved) external;

    function setAuctionReservePrice(uint256 auctionId, uint256 reservePrice) external;

    function createBid(uint256 auctionId) external payable;

    function endAuction(uint256 auctionId) external;

    function cancelAuction(uint256 auctionId) external;

    function withdrawRefund() external;

    function setProtocolFeeBps(uint16 newBps) external;

    function setFeeRecipient(address payable newRecipient) external;

    function setProtocolFeeAdmin(address newAdmin) external;
}
