import { onchainTable, index } from "ponder"

/**
 * Slim schema — only the tables the web app actually queries against.
 *
 * Every PND auction lives in `pndAuctions` keyed by `(house, auctionId)`.
 * Every bid lives in `pndBids` referencing it. State transitions
 * (created → bid → settled / cancelled / reserve-updated) update the row
 * in place rather than appending — the event log is the audit trail.
 *
 * What we deliberately don't model:
 *   - `pndHouses` — the house registry. The factory's
 *     `AuctionHouseCreated` event is enough; if we ever need a row per
 *     house we'll add it. Today the only consumer (`getActiveAuctionCount`)
 *     filters auctions directly by `seller`.
 *   - Per-token tables — those live in the cache layer (pgCache) for now.
 *     Migrate later if cross-cutting queries arrive.
 *   - Foundation NFTMarket events — out of scope for v1; this indexer is
 *     PND-only.
 */

export const pndAuctions = onchainTable(
  "pnd_auctions",
  (t) => ({
    // `${house}-${auctionId}` for global uniqueness across all houses.
    id: t.text().primaryKey(),
    house: t.hex().notNull(),
    auctionId: t.bigint().notNull(),
    tokenContract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    // The token owner who consigned the auction. Cached as `seller` to
    // match the web app's existing terminology and keep query shapes the
    // same as the RPC fallback path.
    seller: t.hex().notNull(),
    reservePrice: t.bigint().notNull(),
    duration: t.bigint().notNull(),
    // Live auction state, updated as bids land:
    amount: t.bigint().notNull(), // current high bid; 0n pre-bid
    bidder: t.hex().notNull(), // 0x0 pre-bid
    firstBidTime: t.bigint().notNull(), // 0n pre-bid
    endTime: t.bigint().notNull(), // 0n pre-bid; firstBidTime + duration after
    // Lifecycle:
    status: t.text().notNull(), // "active" | "settled" | "cancelled"
    // Settlement payout fields, populated when status flips to "settled":
    winner: t.hex(),
    sellerProceeds: t.bigint(),
    protocolFee: t.bigint(),
    // Audit:
    createdAtBlock: t.bigint().notNull(),
    createdAtTime: t.bigint().notNull(),
    settledAtBlock: t.bigint(),
    settledAtTime: t.bigint(),
  }),
  // The two queries the web app will hit hardest:
  //   - getActiveAuctionCount(seller) → seller + status = active
  //   - getAuctionForToken(contract, tokenId) → tokenContract + tokenId
  //     filtered to active. Lookup is point-or-small-set, so a composite
  //     index on (tokenContract, tokenId) is enough.
  (table) => ({
    sellerStatusIdx: index().on(table.seller, table.status),
    tokenIdx: index().on(table.tokenContract, table.tokenId),
  }),
)

export const pndBids = onchainTable(
  "pnd_bids",
  (t) => ({
    // `${txHash}-${logIndex}` to disambiguate multi-log txs.
    id: t.text().primaryKey(),
    auctionId: t.text().notNull(), // FK to pndAuctions.id
    bidder: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    firstBid: t.boolean().notNull(),
    extended: t.boolean().notNull(),
  }),
  (table) => ({
    // Bid history per auction is rendered newest-first in the panel.
    auctionIdx: index().on(table.auctionId, table.blockNumber),
  }),
)
