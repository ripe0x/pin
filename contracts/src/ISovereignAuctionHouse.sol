// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

/// @title Sovereign Auction House interface
/// @notice ETH-denominated reserve auctions for ERC721 tokens. Adapted from
///         Zora's AuctionHouse (audited 2021), ported to Solidity 0.8 and
///         restructured as per-owner EIP-1167 minimal-proxy clones — every
///         seller (artist or collector) deploys and runs their own house.
/// @dev No protocol-level admin or upgrade path. Protocol fee + recipient
///      are fixed at initialize. House ownership is locked at deploy
///      (transferOwnership / renounceOwnership revert) so a compromised key
///      can't drain auctions by reassigning the house out from under the
///      escrowed NFTs.
interface ISovereignAuctionHouse {
    /// @notice Per-auction state.
    /// @param tokenId        ERC721 token id under auction.
    /// @param tokenContract  ERC721 contract address.
    /// @param firstBidTime   Unix timestamp of the first bid (0 = no bids).
    ///                       Auction timer starts here.
    /// @param amount         Current high bid in wei (0 before any bids).
    /// @param reservePrice   Minimum first-bid amount in wei.
    /// @param tokenOwner     Seller address. Captured at createAuction.
    /// @param endTime        Unix timestamp at which the auction ends. 0 until
    ///                       the first bid lands; then `firstBidTime + duration`,
    ///                       extended by late bids (TIME_BUFFER).
    /// @param bidder         Current high bidder (zero before any bids).
    /// @param duration       Auction window in seconds, captured at create
    ///                       time. Used to compute endTime on the first bid.
    struct Auction {
        uint256 tokenId;
        address tokenContract;
        uint64 firstBidTime;
        uint256 amount;
        uint256 reservePrice;
        address tokenOwner;
        uint64 endTime;
        address payable bidder;
        uint64 duration;
    }

    /// @notice Emitted when a new auction is registered and the NFT escrowed.
    event AuctionCreated(
        uint256 indexed auctionId,
        uint256 indexed tokenId,
        address indexed tokenContract,
        uint256 duration,
        uint256 reservePrice,
        address tokenOwner
    );

    /// @notice Emitted when the seller updates the reserve before the first
    ///         bid lands.
    event AuctionReservePriceUpdated(
        uint256 indexed auctionId,
        uint256 reservePrice
    );

    /// @notice Emitted on every bid. `firstBid` flags the bid that starts the
    ///         timer; `extended` flags bids inside TIME_BUFFER that pushed the
    ///         end time out.
    event AuctionBid(
        uint256 indexed auctionId,
        address indexed bidder,
        uint256 amount,
        bool firstBid,
        bool extended
    );

    /// @notice Emitted when a late bid pushed the auction end time out.
    event AuctionEndTimeUpdated(
        uint256 indexed auctionId,
        uint64 newEndTime
    );

    /// @notice Emitted when an auction settles. Includes the full payout
    ///         breakdown so indexers can recover fee math without re-running
    ///         the contract logic.
    event AuctionEnded(
        uint256 indexed auctionId,
        address tokenOwner,
        address winner,
        uint256 sellerProceeds,
        uint256 protocolFee
    );

    /// @notice Emitted when an auction is cancelled (only valid before any
    ///         bids land).
    event AuctionCanceled(uint256 indexed auctionId);

    /// @notice Emitted when an ETH push fails and is credited to a withdrawable
    ///         pull-payment balance instead.
    event RefundCredited(address indexed to, uint256 amount);

    /// @notice Emitted when a recipient pulls their credited refund.
    event RefundWithdrawn(address indexed to, uint256 amount);

    /// @notice Emitted when the house owner recovers a misdirected ERC721
    ///         that landed on the contract outside of the auction flow.
    event StuckERC721Recovered(
        address indexed tokenContract,
        uint256 indexed tokenId,
        address to
    );

    /// @notice Register a new auction and escrow the NFT in this contract.
    /// @param tokenId        ERC721 token id to auction.
    /// @param tokenContract  ERC721 contract address.
    /// @param duration       Auction window in seconds (must be > 0).
    /// @param reservePrice   Minimum first-bid amount in wei.
    /// @return auctionId     The newly assigned auction id.
    function createAuction(
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice
    ) external returns (uint256 auctionId);

    /// @notice Register multiple auctions for the same collection in one tx.
    ///         Same fee terms + duration apply to each. Reverts the whole
    ///         batch if any single createAuction fails.
    /// @param tokenContract  ERC721 contract for every token in the batch.
    /// @param tokenIds       Token ids to auction.
    /// @param reservePrice   Reserve applied to every auction in the batch.
    /// @param duration       Duration applied to every auction in the batch.
    /// @return auctionIds    Newly assigned auction ids, aligned with tokenIds.
    function bulkCreateAuctions(
        address tokenContract,
        uint256[] calldata tokenIds,
        uint256 reservePrice,
        uint256 duration
    ) external returns (uint256[] memory auctionIds);

    /// @notice Seller-only: update the reserve before any bids land. Reverts
    ///         after the first bid.
    function setAuctionReservePrice(uint256 auctionId, uint256 reservePrice) external;

    /// @notice Place a bid. The bid amount is the value sent (msg.value).
    ///         Must be > 0, >= reservePrice for the first bid, and exceed the
    ///         current high bid by at least MIN_BID_INCREMENT_BPS (with a
    ///         1-wei floor when the bps math rounds to zero). Bids in the
    ///         last TIME_BUFFER window extend the auction end time.
    function createBid(uint256 auctionId) external payable;

    /// @notice Settle a finished auction: transfer the NFT to the winner and
    ///         pay out protocol fee → seller. Anyone can call.
    function endAuction(uint256 auctionId) external;

    /// @notice Seller-only: cancel a pending auction and return the escrowed
    ///         NFT. Only valid before the first bid.
    function cancelAuction(uint256 auctionId) external;

    /// @notice Owner-only: cancel multiple pending auctions in one tx. Each
    ///         must still be pre-bid; reverts the whole batch on any
    ///         already-started auction.
    /// @dev    NOTE: this is `onlyOwner` and bypasses the per-auction
    ///         `tokenOwner` check that `cancelAuction` enforces. If the house
    ///         owner listed a token they didn't themselves own (via ERC721
    ///         approval from the real owner), they can still cancel that
    ///         auction unilaterally. The NFT returns to its real owner, so
    ///         funds aren't at risk, but the lister can grief their approved
    ///         counterparties. This is consistent with the "you trust the
    ///         house owner" framing — explicit so it's not a surprise.
    function bulkCancelAuctions(uint256[] calldata auctionIds) external;

    /// @notice Pull-payment: claim ETH that was credited to msg.sender by a
    ///         failed push (e.g. contract wallet that reverts on receive).
    function withdrawRefund() external;
}
