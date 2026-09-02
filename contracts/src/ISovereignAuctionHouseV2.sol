// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

/// @title Sovereign Auction House V2 interface
/// @notice ETH reserve auctions for ERC721 and ERC1155 tokens. Settlement
///         pays the seller unconditionally; token delivery is attempted with
///         a fixed gas stipend and, on failure, deferred to a claim anyone
///         may trigger for the winner, or the winner may redirect. If the
///         winner never claims, the seller may reclaim the lot after a
///         timeout. No sale ever unwinds.
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
        address fundsRecipient,
        uint64 listingExpiry
    );
    event Auction1155Created(
        uint256 indexed auctionId,
        uint256 indexed tokenId,
        address indexed tokenContract,
        uint256 quantity,
        uint256 duration,
        uint256 reservePrice,
        address tokenOwner,
        address fundsRecipient,
        uint64 listingExpiry
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
    /// @notice Emitted when reclaimStuckLot returns a deferred lot to the
    ///         seller after PENDING_DELIVERY_TIMEOUT has passed unclaimed and
    ///         a delivery retry to the recorded winner still fails. If that
    ///         retry succeeds instead, LotClaimed is emitted in its place.
    event LotReclaimed(uint256 indexed auctionId, address indexed tokenOwner);
    event AuctionCanceled(uint256 indexed auctionId);
    event RefundCredited(address indexed to, uint256 amount);
    event RefundWithdrawn(address indexed account, address indexed recipient, uint256 amount);
    event StuckERC721Recovered(address indexed tokenContract, uint256 indexed tokenId, address to);
    event StuckERC1155Recovered(address indexed tokenContract, uint256 indexed tokenId, uint256 quantity, address to);

    /// @notice Lists an ERC721 for auction. The house owner may list a
    ///         third party's token (consignment): `tokenOwner` is read from
    ///         the token itself and proceeds go to that owner's
    ///         `fundsRecipient`, not the house owner. `listingExpiry_` sets
    ///         the no-bid close date for the listing: 0 means no expiry, a
    ///         nonzero value must be strictly in the future and is stored
    ///         in `listingExpiry`. A bid placed before the expiry starts the
    ///         normal auction clock and the expiry no longer applies;
    ///         `createBid` only checks it while `firstBidTime` is unset. The
    ///         token owner can still change or clear it pre-bid via
    ///         `setAuctionListingExpiry`, or cancel entirely via
    ///         `cancelAuction`.
    function createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice,
        uint64 listingExpiry_
    ) external returns (uint256 auctionId);

    function create1155Auction(
        uint256 tokenId,
        address tokenContract,
        uint256 quantity,
        uint256 duration,
        uint256 reservePrice,
        uint64 listingExpiry_
    ) external returns (uint256 auctionId);

    /// @notice Returns the full auction record as a struct. The mapping's
    ///         auto-generated getter returns the same data as a flat tuple;
    ///         this exists so callers that need the whole record can decode
    ///         one struct instead of the full field list.
    function getAuction(uint256 auctionId) external view returns (Auction memory);

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

    /// @notice Claims a lot whose delivery was deferred at settlement.
    ///         Anyone may call this with `to == address(0)` to trigger
    ///         delivery to the recorded winner; only that winner may redirect
    ///         delivery elsewhere via a nonzero `to`. Reverts if the auction
    ///         has no deferred delivery, or if a non-winner passes a nonzero
    ///         `to`. A revert during delivery reverts the whole call, leaving
    ///         the claim retryable. The redirect is best-effort: the pending
    ///         state is consumed by whichever call succeeds first, so a third
    ///         party triggering delivery to the winner with `to == address(0)`
    ///         before the winner redirects permanently forecloses that
    ///         redirect. The token always still reaches the winner's own bid
    ///         address in that case.
    function claimLot(uint256 auctionId, address to) external;

    /// @notice Lets the seller reclaim a deferred lot once
    ///         PENDING_DELIVERY_TIMEOUT has passed since deferral. The seller
    ///         was already paid at settlement. This first retries delivery to
    ///         the recorded winner and falls back to the seller only if that
    ///         retry also fails, so this only bounds how long an
    ///         undeliverable lot can stay escrowed waiting on the winner.
    function reclaimStuckLot(uint256 auctionId) external;
}
