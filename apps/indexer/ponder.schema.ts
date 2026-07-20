import { onchainTable, index } from "ponder"

/**
 * v2 Ponder schema. Dropped vs v1: srv2Auctions, tlAuctions,
 * mintArtistTokens, tlArtistTokens. Those reads now go to the worker-
 * owned `artist_tokens` table (per-platform rows).
 *
 * Keep family:
 *   - pnd_* (PND)
 *   - fnd_* (Foundation NFTMarket auctions, bids, buy-nows, sales,
 *     collections, shared-contract artist tokens)
 *   - catalog_* (on-chain Catalog registry)
 *   - srv2_artist_tokens (SR V2 shared 1/1; artist = mint recipient)
 *   - mint_creators (Mint factory discovery only)
 *   - tl_creators (TL deployer discovery only)
 */

// ─── PND ─────────────────────────────────────────────────────────────────

export const pndAuctions = onchainTable(
  "pnd_auctions",
  (t) => ({
    id: t.text().primaryKey(),
    house: t.hex().notNull(),
    auctionId: t.bigint().notNull(),
    tokenContract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    seller: t.hex().notNull(),
    reservePrice: t.bigint().notNull(),
    duration: t.bigint().notNull(),
    amount: t.bigint().notNull(),
    bidder: t.hex().notNull(),
    firstBidTime: t.bigint().notNull(),
    endTime: t.bigint().notNull(),
    status: t.text().notNull(),
    winner: t.hex(),
    sellerProceeds: t.bigint(),
    protocolFee: t.bigint(),
    createdAtBlock: t.bigint().notNull(),
    createdAtTime: t.bigint().notNull(),
    settledAtBlock: t.bigint(),
    settledAtTime: t.bigint(),
    createdTxHash: t.hex(),
    lifecycleTxHash: t.hex(),
  }),
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
    id: t.text().primaryKey(),
    auctionId: t.text().notNull(),
    bidder: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    firstBid: t.boolean().notNull(),
    extended: t.boolean().notNull(),
  }),
  (table) => ({
    auctionIdx: index().on(table.auctionId, table.blockNumber),
  }),
)

// ─── Foundation NFTMarket ────────────────────────────────────────────────

export const fndAuctions = onchainTable(
  "fnd_auctions",
  (t) => ({
    auctionId: t.bigint().primaryKey(),
    nftContract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    seller: t.hex().notNull(),
    reservePrice: t.bigint().notNull(),
    durationSeconds: t.bigint().notNull(),
    highestBid: t.bigint().notNull(),
    highestBidder: t.hex(),
    endTime: t.bigint().notNull(),
    status: t.text().notNull(),
    finalizedTotalFees: t.bigint(),
    finalizedCreatorRev: t.bigint(),
    finalizedSellerRev: t.bigint(),
    createdAtBlock: t.bigint().notNull(),
    createdAtTime: t.bigint().notNull(),
    finalizedAtTime: t.bigint(),
    finalizedTxHash: t.hex(),
  }),
  (table) => ({
    sellerStatusIdx: index().on(table.seller, table.status),
    tokenIdx: index().on(table.nftContract, table.tokenId),
  }),
)

export const fndBids = onchainTable(
  "fnd_bids",
  (t) => ({
    id: t.text().primaryKey(),
    auctionId: t.bigint().notNull(),
    bidder: t.hex().notNull(),
    amount: t.bigint().notNull(),
    endTime: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    auctionIdx: index().on(table.auctionId, table.blockNumber),
  }),
)

export const fndBuyNows = onchainTable(
  "fnd_buy_nows",
  (t) => ({
    id: t.text().primaryKey(),
    nftContract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    seller: t.hex().notNull(),
    price: t.bigint().notNull(),
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

export const fndSales = onchainTable(
  "fnd_sales",
  (t) => ({
    id: t.text().primaryKey(),
    nftContract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    seller: t.hex().notNull(),
    buyer: t.hex().notNull(),
    priceWei: t.bigint().notNull(),
    source: t.text().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenTimeIdx: index().on(table.nftContract, table.tokenId, table.blockTime),
  }),
)

export const fndCollections = onchainTable(
  "fnd_collections",
  (t) => ({
    collection: t.hex().primaryKey(),
    creator: t.hex().notNull(),
    kind: t.text().notNull(),
    name: t.text(),
    symbol: t.text(),
    createdAtBlock: t.bigint().notNull(),
    createdAtTime: t.bigint().notNull(),
  }),
  (table) => ({
    creatorIdx: index().on(table.creator),
  }),
)

// Populated by FoundationNFT:Minted (shared 1/1 contract).
// NOT populated by per-clone FoundationCollection Transfer events in v2 —
// that work moves to the worker's scan-fnd-collections task.
export const fndArtistTokens = onchainTable(
  "fnd_artist_tokens",
  (t) => ({
    id: t.text().primaryKey(),
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

export const catalogContracts = onchainTable(
  "catalog_contracts",
  (t) => ({
    id: t.text().primaryKey(),
    artist: t.hex().notNull(),
    contractAddress: t.hex().notNull(),
    actor: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    artistIdx: index().on(table.artist, table.blockNumber),
    contractIdx: index().on(table.contractAddress),
  }),
)

export const catalogTokens = onchainTable(
  "catalog_tokens",
  (t) => ({
    id: t.text().primaryKey(),
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

// ─── Discovery-only registries ───────────────────────────────────────────
// One row per artist-deploys-a-clone. Worker reads these to know which
// clones to per-artist-scan. v1's per-clone Transfer subscriptions are
// dropped in favor of the worker's cursor-driven scans.

export const mintCreators = onchainTable(
  "mint_creators",
  (t) => ({
    contract: t.hex().primaryKey(),
    address: t.hex().notNull(),
    firstSeenBlock: t.bigint().notNull(),
    firstSeenTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    addressIdx: index().on(table.address),
  }),
)

export const tlCreators = onchainTable(
  "tl_creators",
  (t) => ({
    contract: t.hex().primaryKey(),
    sender: t.hex().notNull(),
    implementation: t.hex().notNull(),
    cType: t.text().notNull(),
    version: t.text().notNull(),
    firstSeenBlock: t.bigint().notNull(),
    firstSeenTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    senderIdx: index().on(table.sender),
  }),
)

// SR V2 shared 1/1. Artist = mint recipient (no creators registry needed).
export const srv2ArtistTokens = onchainTable(
  "srv2_artist_tokens",
  (t) => ({
    id: t.text().primaryKey(),
    creator: t.hex().notNull(),
    contract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    blockTime: t.bigint().notNull(),
  }),
  (table) => ({
    creatorBlockIdx: index().on(table.creator, table.blockNumber),
    contractTokenIdx: index().on(table.contract, table.tokenId),
  }),
)

// ─── MURI Protocol (on-chain media-permanence overlay) ───────────────────
// Fixed shared singleton (0x0000000000C2A0B63ab4aA971B08B905E5875b01).
// `muri_contracts` = which NFT contracts have registered with MURI (one row
// per ContractRegistered). `muri_tokens` = per-token preservation state used
// by the web "preserved on-chain · N fallbacks" badge. Counts are read from
// `getArtwork` on each data-changing event (the init event carries no count).

export const muriContracts = onchainTable(
  "muri_contracts",
  (t) => ({
    // The NFT contract registered with MURI (MURI's `contractAddress`).
    contract: t.hex().primaryKey(),
    // The operator/implementation (e.g. the Manifold extension).
    operator: t.hex().notNull(),
    registerer: t.hex().notNull(),
    registeredAtBlock: t.bigint().notNull(),
    registeredAtTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    operatorIdx: index().on(table.operator),
  }),
)

export const muriTokens = onchainTable(
  "muri_tokens",
  (t) => ({
    id: t.text().primaryKey(), // `${contract}-${tokenId}`
    // MURI's `creator` arg IS the NFT contract address.
    contract: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    artistUriCount: t.integer().notNull(),
    collectorUriCount: t.integer().notNull(),
    selectedIndex: t.integer().notNull(),
    mimeType: t.text(),
    fileHash: t.text(),
    isAnimationUri: t.boolean().notNull(),
    displayMode: t.integer(), // 0 DIRECT_FILE, 1 HTML; null until a DisplayModeUpdated event
    registeredAtBlock: t.bigint().notNull(),
    registeredAtTime: t.bigint().notNull(),
    updatedAtBlock: t.bigint().notNull(),
  }),
  (table) => ({
    contractTokenIdx: index().on(table.contract, table.tokenId),
  }),
)

// ─── PND Surface System (contracts/src/surface/) ─────────────────────────
// DEPLOY-GATED (see ponder.config.ts): these tables exist regardless, but
// stay empty until CollectionFactory + Collection are
// wired into `contracts`. One row per artist collection deployed via the
// factory (`collections`), one row per live token incl. pooled re-mints
// (`collection_tokens`), and an append-only mint log (`collection_mints`).
// Handlers are kept minimal per AGENTS.md — enrichment (metadata, rendered
// art, etc.) is the worker's/web's job reading these rows, not Ponder's.
//
// Thin-token rearchitecture (docs/pnd-surface-thin-token-rearchitecture.md):
// the token no longer carries sale economics (price, window, referral,
// value custody, SurfaceStatus) — that moved to the per-collection
// FixedPriceMinter clone `createSurface` wires. `Minted` dropped
// referrer/statusAtMint/mintBlock and gained `minter` (the calling minter,
// cross-minter attribution). `collections.primaryMinter` is the collection's
// frontend-discovery default: seeded from `SurfaceCreated.primaryMinter` and
// kept current by the per-collection `PrimaryMinterSet` event (repoint,
// revoke-clear, pooled sole-minter churn), null when none is set. `minters`
// is the reverse index (minter clone -> collection) the FixedPriceMinter:
// Sold/ReferralPaid handlers use to resolve which collection a sale belongs
// to, since those events are emitted by the minter contract, not the
// collection. The `minters` reverse index is keyed off SurfaceCreated's
// primaryMinter too (the canonical clone createSurface wires), independent
// of later primaryMinter repoints.

export const collections = onchainTable(
  "collections",
  (t) => ({
    // The deployed Collection clone address.
    collection: t.hex().primaryKey(),
    owner: t.hex().notNull(),
    // Frontend-discovery default: mirrors the collection's own
    // primaryMinter(), null when unset. Seeded from SurfaceCreated and kept
    // live by the Surface:PrimaryMinterSet handler — there is no minterOf
    // storage mapping onchain, so this column IS the discovery record.
    primaryMinter: t.hex(),
    createdAtBlock: t.bigint().notNull(),
    createdAtTime: t.bigint().notNull(),
    createdTxHash: t.hex().notNull(),
  }),
  (table) => ({
    ownerIdx: index().on(table.owner),
  }),
)

// Reverse index for the canonical-minter binding: given a FixedPriceMinter
// clone address (the Sold/ReferralPaid event's own contract), resolve which
// collection it sells for. Populated alongside `collections` whenever
// SurfaceCreated carries a nonzero primaryMinter; independent of later
// primaryMinter repoints on `collections`.
export const minters = onchainTable("minters", (t) => ({
  minter: t.hex().primaryKey(),
  collection: t.hex().notNull(),
}))

// Current state per token. Pooled collections can burn-then-remint the
// same tokenId as a new instance (see IPooledSurface.mintToId) — a
// re-mint UPDATEs this row in place (fresh mark fields, burned reset to
// false) rather than inserting a new one, so `id` stays the durable
// per-(collection,tokenId) identity across the token's burn/remint cycles.
export const collectionTokens = onchainTable(
  "collection_tokens",
  (t) => ({
    id: t.text().primaryKey(), // `${collection}-${tokenId}`
    collection: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    // Current holder, from the Minted event's `to`. Ponder does not track
    // post-mint Transfer for this contract (that's an owner-tracking
    // concern the web/worker layer can add via Transfer if/when needed).
    mintedTo: t.hex().notNull(),
    // The minter contract that issued this token (Minted event's `minter`,
    // i.e. msg.sender on the token) — cross-minter attribution with no
    // trace lookup. referrer/statusAtMint/mintBlock no longer exist: the
    // token no longer sees value (referral is the minter's own event), and
    // the mint block is this row's own updatedAtBlock/updatedAtTime.
    minter: t.hex().notNull(),
    // Offset of this tokenId within its own Minted call's
    // [firstTokenId, firstTokenId + quantity - 1] range (0 for a single-id
    // pooled mint). NOT the contract's global per-collection mint order —
    // that value isn't emitted by Minted and reading it back onchain per
    // event would mean an extra RPC call per mint, which these handlers
    // deliberately avoid (see AGENTS.md: worker/web enrich, Ponder stays
    // dumb).
    mintIndex: t.integer().notNull(),
    burned: t.boolean().notNull(),
    updatedAtBlock: t.bigint().notNull(),
    updatedAtTime: t.bigint().notNull(),
  }),
  (table) => ({
    collectionIdx: index().on(table.collection, table.tokenId),
    mintedToIdx: index().on(table.mintedTo),
  }),
)

// Append-only: one row per Minted event, including every re-mint of a
// previously-burned pooled id. Never updated — the immutable mint history
// that `collection_tokens` (current state) is derived from.
export const collectionMints = onchainTable(
  "collection_mints",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    collection: t.hex().notNull(),
    minter: t.hex().notNull(),
    firstTokenId: t.bigint().notNull(),
    quantity: t.bigint().notNull(),
    to: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    collectionIdx: index().on(table.collection, table.blockNumber),
    toIdx: index().on(table.to),
  }),
)

// Append-only: one row per FixedPriceMinter Sold event (the canonical
// minter's own sale record — price, referrer, payer, distinct from the
// token's Minted event, which carries no economics). `collection` is
// resolved via the `minters` reverse index since Sold is emitted by the
// minter clone, not the collection.
export const collectionSales = onchainTable(
  "collection_sales",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    collection: t.hex().notNull(),
    minter: t.hex().notNull(),
    payer: t.hex().notNull(),
    to: t.hex().notNull(),
    referrer: t.hex().notNull(),
    quantity: t.bigint().notNull(),
    paid: t.bigint().notNull(),
    firstTokenId: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    collectionIdx: index().on(table.collection, table.blockNumber),
    payerIdx: index().on(table.payer),
  }),
)

// Append-only: one row per FixedPriceMinter ReferralPaid event. Separate
// from `collection_sales` rather than fused onto the Sold row: both events
// fire in the same `mint()` call (ReferralPaid from inside `_settle`,
// before the trailing `Sold` emit) but keying a join on tx hash + call
// ordering is more fragile than two independent append-only logs.
export const collectionReferrals = onchainTable(
  "collection_referrals",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    collection: t.hex().notNull(),
    minter: t.hex().notNull(),
    referrer: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    collectionIdx: index().on(table.collection, table.blockNumber),
    referrerIdx: index().on(table.referrer),
  }),
)
