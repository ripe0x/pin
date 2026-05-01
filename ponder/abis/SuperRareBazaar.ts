/**
 * SuperRare Bazaar ABI (subset).
 *
 * Confirmed against verified mainnet source at
 * 0x6d7c44773c52d396f43c2d511b81aa168e9a7a42.
 *
 * The full Bazaar ABI is large (offers, buy-now, sales, etc.). We only
 * include what our auction integration touches: auction state reads,
 * bid/settle/cancel writes, and the events the lazy index scans.
 *
 * Notes on auction state shape (from the contract's storage):
 *   - `tokenAuctions(originContract, tokenId)` returns the static config
 *     `(auctionCreator, creationBlock, startingTime, lengthOfAuction,
 *      currencyAddress, minimumBid, auctionType)`
 *   - `auctionBids(originContract, tokenId)` returns the live bid
 *     `(bidder, currencyAddress, amount, marketplaceFee)`
 *   - End time is derived: `startingTime + lengthOfAuction` once the
 *     first bid extends `startingTime` to the bid block; pre-bid the
 *     auction has no live timer (treated as `awaitingFirstBid`).
 *   - `currencyAddress = 0x0` denotes ETH bids; non-zero is ERC-20 (rare;
 *     out of scope for the MVP — adapter returns null for non-ETH).
 */
export const superrareBazaarAbi = [
  // ── Reads ─────────────────────────────────────────────────────────────
  {
    type: "function",
    name: "tokenAuctions",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "uint256" },
    ],
    outputs: [
      { name: "auctionCreator", type: "address" },
      { name: "creationBlock", type: "uint256" },
      { name: "startingTime", type: "uint256" },
      { name: "lengthOfAuction", type: "uint256" },
      { name: "currencyAddress", type: "address" },
      { name: "minimumBid", type: "uint256" },
      { name: "auctionType", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "auctionBids",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "uint256" },
    ],
    outputs: [
      { name: "bidder", type: "address" },
      { name: "currencyAddress", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "marketplaceFee", type: "uint8" },
    ],
  },

  // ── Writes ────────────────────────────────────────────────────────────
  // Bidding currency: ETH bids pass `_currencyAddress = address(0)` and
  // attach `value = _amount`. ERC-20 bids attach no value and require a
  // prior approve(); we don't surface those in the UI today.
  {
    type: "function",
    name: "bid",
    stateMutability: "payable",
    inputs: [
      { name: "_originContract", type: "address" },
      { name: "_tokenId", type: "uint256" },
      { name: "_currencyAddress", type: "address" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleAuction",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_originContract", type: "address" },
      { name: "_tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelAuction",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_originContract", type: "address" },
      { name: "_tokenId", type: "uint256" },
    ],
    outputs: [],
  },

  // ── Events ────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "NewAuction",
    inputs: [
      { name: "_contractAddress", type: "address", indexed: true },
      { name: "_tokenId", type: "uint256", indexed: true },
      { name: "_auctionCreator", type: "address", indexed: true },
      { name: "_currencyAddress", type: "address", indexed: false },
      { name: "_startingTime", type: "uint256", indexed: false },
      { name: "_minimumBid", type: "uint256", indexed: false },
      { name: "_lengthOfAuction", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AuctionBid",
    inputs: [
      { name: "_contractAddress", type: "address", indexed: true },
      { name: "_bidder", type: "address", indexed: true },
      { name: "_tokenId", type: "uint256", indexed: true },
      { name: "_currencyAddress", type: "address", indexed: false },
      { name: "_amount", type: "uint256", indexed: false },
      { name: "_startedAuction", type: "bool", indexed: false },
      { name: "_newAuctionLength", type: "uint256", indexed: false },
      { name: "_previousBidder", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AuctionSettled",
    inputs: [
      { name: "_contractAddress", type: "address", indexed: true },
      { name: "_bidder", type: "address", indexed: true },
      { name: "_seller", type: "address", indexed: false },
      { name: "_tokenId", type: "uint256", indexed: true },
      { name: "_currencyAddress", type: "address", indexed: false },
      { name: "_amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CancelAuction",
    inputs: [
      { name: "_contractAddress", type: "address", indexed: true },
      { name: "_tokenId", type: "uint256", indexed: true },
      { name: "_auctionCreator", type: "address", indexed: true },
    ],
  },
] as const
