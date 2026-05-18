/**
 * Transient Labs Auction House ABI (subset).
 *
 * Confirmed against verified mainnet source at
 * 0x6f66b95a0C512f3497FB46660E0BC3B94B989F8d (v2.6.1).
 *
 * Architectural notes:
 *   - Custody pattern: the Auction House calls `transferFrom` on the
 *     NFT contract when a listing is configured, so `ownerOf` during
 *     an active listing returns this contract's address. Same shape as
 *     Foundation's NFTMarket — owner-based routing in `auctions.ts`
 *     dispatches cleanly without the fall-through hack we use for SR
 *     Bazaar (which doesn't custody).
 *   - One contract handles BOTH auctions and buy-nows. The `Listing`
 *     struct's `type_` enum discriminates. We surface auctions in our
 *     UI today; buy-now write paths are deferred.
 *   - Events `AuctionBid`, `AuctionSettled`, `BuyNowFulfilled`, and
 *     `ListingCanceled` ALL have `nftAddress` and `tokenId` indexed —
 *     per-token last-sale lookups are cheap (better than SR Bazaar's
 *     Sold/AcceptOffer events which lack indexed _tokenId).
 *
 * Listing struct shape (from `getListing` outputs):
 *   uint8   type_           — 0=NotConfigured, 1=Scheduled auction,
 *                              2=Reserve auction, 3=BuyNow (verified by
 *                              probing live listings; confirm if a
 *                              tx fails for an unfamiliar value)
 *   bool    zeroProtocolFee — flag set by admin for fee-exempt listings
 *   address seller
 *   address payoutReceiver  — who receives seller proceeds
 *   address currencyAddress — 0x0 for ETH, else ERC-20
 *   uint256 openTime        — bidding can't start before this ts
 *   uint256 reservePrice    — minimum first-bid amount
 *   uint256 buyNowPrice     — instant-buy price (0 when no buy-now)
 *   uint256 startTime       — set to first-bid block ts; 0 pre-bid
 *   uint256 duration        — auction length in seconds
 *   address recipient       — NFT recipient if auction settles
 *   address highestBidder
 *   uint256 highestBid
 *   uint256 id              — globally-incrementing listing id
 *
 * Bid currency: only ETH bids surface in our UI today.
 * `bid()` is payable — the buyer sends `msg.value` covering the bid
 * amount. Whether a buyer's premium applies on top is verified at
 * fork-test time (TL may differ from SR Bazaar's 3% premium).
 */
const listingTuple = {
  type: "tuple",
  components: [
    { name: "type_", type: "uint8" },
    { name: "zeroProtocolFee", type: "bool" },
    { name: "seller", type: "address" },
    { name: "payoutReceiver", type: "address" },
    { name: "currencyAddress", type: "address" },
    { name: "openTime", type: "uint256" },
    { name: "reservePrice", type: "uint256" },
    { name: "buyNowPrice", type: "uint256" },
    { name: "startTime", type: "uint256" },
    { name: "duration", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "highestBidder", type: "address" },
    { name: "highestBid", type: "uint256" },
    { name: "id", type: "uint256" },
  ],
} as const

export const transientAuctionHouseAbi = [
  // ── Reads ─────────────────────────────────────────────────────────────
  {
    type: "function",
    name: "getListing",
    stateMutability: "view",
    inputs: [
      { name: "nftAddress", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "", ...listingTuple }],
  },
  {
    type: "function",
    name: "getNextBid",
    stateMutability: "view",
    inputs: [
      { name: "nftAddress", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getRoyalty",
    stateMutability: "view",
    inputs: [
      { name: "nftAddress", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "value", type: "uint256" },
    ],
    outputs: [
      { name: "recipients", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
  },
  {
    type: "function",
    name: "protocolFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "BID_INCREASE_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ── Writes ────────────────────────────────────────────────────────────
  // ETH bids: pass `currencyAddress = address(0)` (set at list time) and
  // attach `value = bid amount` (or amount + premium if TL charges one;
  // verified empirically). `recipient` is who gets the NFT if the
  // bidder wins — usually equals msg.sender for self-bids.
  {
    type: "function",
    name: "bid",
    stateMutability: "payable",
    inputs: [
      { name: "nftAddress", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleAuction",
    stateMutability: "nonpayable",
    inputs: [
      { name: "nftAddress", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  // TL calls cancel `delist` (covers both auctions and buy-nows).
  {
    type: "function",
    name: "delist",
    stateMutability: "nonpayable",
    inputs: [
      { name: "nftAddress", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },

  // ── Events ────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "ListingConfigured",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "nftAddress", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "listing", indexed: false, ...listingTuple },
    ],
  },
  {
    type: "event",
    name: "AuctionBid",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "nftAddress", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "listing", indexed: false, ...listingTuple },
    ],
  },
  {
    type: "event",
    name: "AuctionSettled",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "nftAddress", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "listing", indexed: false, ...listingTuple },
    ],
  },
  {
    type: "event",
    name: "BuyNowFulfilled",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "nftAddress", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: false },
      { name: "listing", indexed: false, ...listingTuple },
    ],
  },
  {
    type: "event",
    name: "ListingCanceled",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "nftAddress", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "listing", indexed: false, ...listingTuple },
    ],
  },
] as const
