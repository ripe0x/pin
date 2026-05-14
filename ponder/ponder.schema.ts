import { onchainTable, index } from "ponder"

/**
 * Slim schema — only the tables the web app actually queries against.
 *
 * Two contract families:
 *   - PND (Sovereign Auction Houses): `pnd_*` tables, keyed by
 *     `(house, auctionId)` because each artist has their own clone.
 *   - Foundation NFTMarket (legacy): `fnd_*` tables, keyed by `auctionId`
 *     alone — a single shared marketplace contract. Powers Foundation
 *     last-sale, bid history, and seller-cancellable-listings reads in
 *     the web app, replacing direct `eth_getLogs` scans.
 *
 * State transitions update rows in place rather than appending — the event
 * log is the audit trail. Per-token tables aren't modeled here; those live
 * in the cache layer (pgCache).
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
    // Source-of-truth tx hashes so the activity feed can render
    // "view tx" links for each lifecycle event. `createdTxHash` is
    // the AuctionCreated tx; `lifecycleTxHash` is the terminal state
    // transition (AuctionEnded or AuctionCanceled), populated when
    // `status` flips off "active".
    createdTxHash: t.hex(),
    lifecycleTxHash: t.hex(),
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

export const pndHouses = onchainTable(
  "pnd_houses",
  (t) => ({
    house: t.hex().primaryKey(),
    owner: t.hex().notNull(),
    feeRecipient: t.hex().notNull(),
    protocolFeeBps: t.integer().notNull(),
    createdAtBlock: t.bigint().notNull(),
    createdAtTime: t.bigint().notNull(),
    /** AuctionHouseCreated tx hash; powers the feed's "view tx" link
     * for `house.deployed` rows. Nullable on existing rows until a
     * Ponder re-sync backfills them from logs. */
    createdTxHash: t.hex(),
  }),
  (table) => ({
    ownerIdx: index().on(table.owner),
    createdIdx: index().on(table.createdAtTime),
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

// ─── Foundation NFTMarket ────────────────────────────────────────────────
// Single shared marketplace contract. AuctionId is unique across all
// auctions ever created on it, so it can be the primary key directly (no
// composite needed unlike PND houses).

export const fndAuctions = onchainTable(
  "fnd_auctions",
  (t) => ({
    auctionId: t.bigint().primaryKey(),
    nftContract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    seller: t.hex().notNull(),
    reservePrice: t.bigint().notNull(),
    durationSeconds: t.bigint().notNull(),
    // Live state, updated as bids land:
    highestBid: t.bigint().notNull(), // 0n pre-bid
    highestBidder: t.hex(), // null pre-bid
    endTime: t.bigint().notNull(), // 0n pre-bid; first-bid time + duration after
    // Lifecycle: "active" | "finalized" | "canceled" | "invalidated"
    status: t.text().notNull(),
    // Settlement payout, populated when finalized:
    finalizedTotalFees: t.bigint(),
    finalizedCreatorRev: t.bigint(),
    finalizedSellerRev: t.bigint(),
    // Audit:
    createdAtBlock: t.bigint().notNull(),
    createdAtTime: t.bigint().notNull(),
    finalizedAtTime: t.bigint(),
    finalizedTxHash: t.hex(),
  }),
  (table) => ({
    // getSellerCancellableListings → (seller, status='active')
    sellerStatusIdx: index().on(table.seller, table.status),
    // last-sale lookup + auction-for-token → (nftContract, tokenId)
    tokenIdx: index().on(table.nftContract, table.tokenId),
  }),
)

export const fndBids = onchainTable(
  "fnd_bids",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    auctionId: t.bigint().notNull(),
    bidder: t.hex().notNull(),
    amount: t.bigint().notNull(),
    endTime: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    // Bid history per auction, rendered newest-first.
    auctionIdx: index().on(table.auctionId, table.blockNumber),
  }),
)

export const fndBuyNows = onchainTable(
  "fnd_buy_nows",
  (t) => ({
    // (nftContract, tokenId) is unique — only one active buy-now per token
    // because BuyPriceSet overwrites on update.
    id: t.text().primaryKey(), // `${nftContract}-${tokenId}`
    nftContract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    seller: t.hex().notNull(),
    price: t.bigint().notNull(),
    // "active" | "canceled" | "accepted" | "invalidated"
    status: t.text().notNull(),
    createdAtTime: t.bigint().notNull(),
    updatedAtTime: t.bigint(),
    acceptedBuyer: t.hex(),
    acceptedTxHash: t.hex(),
    acceptedTotalFees: t.bigint(),
    acceptedCreatorRev: t.bigint(),
    acceptedSellerRev: t.bigint(),
  }),
  (table) => ({
    sellerStatusIdx: index().on(table.seller, table.status),
    tokenIdx: index().on(table.nftContract, table.tokenId),
  }),
)

// Both auction finalizations and buy-now acceptances flow into this single
// "sale happened" stream. last-sale.ts queries here for the most-recent
// row per (contract, tokenId).
export const fndSales = onchainTable(
  "fnd_sales",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    nftContract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    seller: t.hex().notNull(),
    buyer: t.hex().notNull(),
    priceWei: t.bigint().notNull(), // totalFees + creatorRev + sellerRev
    source: t.text().notNull(), // "auction" | "buyNow"
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenTimeIdx: index().on(table.nftContract, table.tokenId, table.blockTime),
  }),
)

// Every Foundation collection contract artists deploy via the V1/V2
// factories. Maps collection address → creator. Powers
// `findArtistCollections` reads (currently 6 parallel getLogs over a 9M-
// block range per artist gallery cold cache).
export const fndCollections = onchainTable(
  "fnd_collections",
  (t) => ({
    collection: t.hex().primaryKey(),
    creator: t.hex().notNull(),
    kind: t.text().notNull(), // "1of1" | "drop"
    name: t.text(),
    symbol: t.text(),
    createdAtBlock: t.bigint().notNull(),
    createdAtTime: t.bigint().notNull(),
  }),
  (table) => ({
    creatorIdx: index().on(table.creator),
  }),
)

// Unified per-artist token list. Two writers populate it:
//   - FoundationNFT:Minted (the shared 1/1 contract)
//   - FoundationCollection:Transfer (mint events on per-artist collection
//     contracts deployed via the factories)
// Powers `discoverArtistTokenRefs` reads on the artist gallery cold cache.
export const fndArtistTokens = onchainTable(
  "fnd_artist_tokens",
  (t) => ({
    id: t.text().primaryKey(), // `${contract}-${tokenId}`
    creator: t.hex().notNull(),
    contract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    blockTime: t.bigint().notNull(),
  }),
  (table) => ({
    creatorIdx: index().on(table.creator, table.blockNumber),
    tokenIdx: index().on(table.contract, table.tokenId),
  }),
)

// ─── Catalog ─────────────────────────────────────────────────────────────
//
// On-chain registry where artist addresses publish pointers to contracts,
// single tokens, and token ranges that belong to their public record.
// Replaces the per-render viem multicall in `apps/web/src/lib/catalog.ts`
// — the page reads from these three tables instead.
//
// Synthetic text IDs (e.g. `${artist}-${contractAddress}`) match the
// rest of the schema and let removal events reuse the same composite
// without a separate "where" delete. The on-chain contract itself
// prevents duplicate inserts (see Catalog.sol's
// ContractAlreadyRegistered / TokenAlreadyRegistered / TokenRangeAlready-
// Registered guards), so a re-org that re-emits an Added event lands
// the same row — `onConflictDoNothing` keeps that idempotent.
//
// `actor` is the `msg.sender` from the on-chain event — same as the
// artist for direct calls, the operator address for `*For` calls.
// Preserved as audit trail; the artist-page read filters strictly on
// `artist`.

export const catalogContracts = onchainTable(
  "catalog_contracts",
  (t) => ({
    id: t.text().primaryKey(), // `${artist}-${contractAddress}`
    artist: t.hex().notNull(),
    contractAddress: t.hex().notNull(),
    actor: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    // /catalog/[address] reads (artist, ORDER BY blockNumber).
    artistIdx: index().on(table.artist, table.blockNumber),
    // Enables future "who declared contract X" cross-artist queries.
    contractIdx: index().on(table.contractAddress),
  }),
)

export const catalogTokens = onchainTable(
  "catalog_tokens",
  (t) => ({
    id: t.text().primaryKey(), // `${artist}-${contractAddress}-${tokenId}`
    artist: t.hex().notNull(),
    contractAddress: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    actor: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    artistIdx: index().on(table.artist, table.blockNumber),
  }),
)

export const catalogRanges = onchainTable(
  "catalog_ranges",
  (t) => ({
    // `${artist}-${contractAddress}-${startTokenId}-${endTokenId}`
    id: t.text().primaryKey(),
    artist: t.hex().notNull(),
    contractAddress: t.hex().notNull(),
    startTokenId: t.bigint().notNull(),
    endTokenId: t.bigint().notNull(),
    actor: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    artistIdx: index().on(table.artist, table.blockNumber),
  }),
)
