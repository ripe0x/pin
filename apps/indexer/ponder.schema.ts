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

// ─── Homage ("Homage to the Punk") — fixed shared singleton ──────────────
// Deploy-gated: only populated once HOMAGE_ADDRESS + HOMAGE_START_BLOCK are
// set in the indexer env (see ponder.config.ts). `tokenId == punkId` (1:1
// with CryptoPunks, supply 10,000). redeem() burns a homage and returns its
// id to the mintable pool, so ids CHURN — a punkId can be minted, redeemed,
// and re-minted. Web reads the phase schedule + supply from these tables
// (Postgres), not RPC (indexer-first).

// Per-punkId current state. One row per punkId ever minted; `outstanding`
// flips false on redeem and true again on the next mint. Because ids churn,
// this table is the authoritative "who holds punk N's homage right now" and
// "is it currently outstanding" source; full history lives in homage_activity.
export const homageTokens = onchainTable(
  "homage_tokens",
  (t) => ({
    // punkId as text (tokenId == punkId, 0..9999). Stable pk across churn.
    punkId: t.bigint().primaryKey(),
    // Current holder (address(0) while redeemed / not outstanding).
    holder: t.hex().notNull(),
    // True while a homage for this punkId exists on-chain; false after redeem.
    outstanding: t.boolean().notNull(),
    // How the CURRENT (most recent) mint entered: "claim" (Claimed event),
    // "allowlist" or "public" (Minted event, disambiguated by mint timestamp
    // vs the indexed schedule in homage_config). null only if a Minted fired
    // before any ScheduleSet was indexed (shouldn't happen in practice).
    mintPhase: t.text(),
    // Economics of the CURRENT mint (from Minted/Claimed args). ethSwapped is
    // the ETH the contract swapped into $111; received111 the $111 it got.
    ethSwapped: t.bigint(),
    received111: t.bigint(),
    // First time this punkId was ever minted, and the most recent mint time.
    firstMintedAtTime: t.bigint().notNull(),
    lastMintedAtTime: t.bigint().notNull(),
    lastMintedAtBlock: t.bigint().notNull(),
    // Number of times this punkId has been redeemed (churn counter).
    redeemCount: t.integer().notNull(),
  }),
  (table) => ({
    holderIdx: index().on(table.holder),
    outstandingIdx: index().on(table.outstanding),
  }),
)

// Append-only activity log. One row per Minted / Claimed / Redeemed /
// Transfer (secondary only — mint/burn Transfers are skipped, already
// captured as mint/claim/redeem). Drives the per-token provenance timeline.
export const homageActivity = onchainTable(
  "homage_activity",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    // "mint" | "claim" | "redeem" | "transfer"
    type: t.text().notNull(),
    punkId: t.bigint().notNull(),
    from: t.hex(), // null for mint/claim (from = address(0))
    to: t.hex(), // null for redeem (to = address(0))
    // Populated for mint/claim (ethSwapped/received111) and redeem (amount111).
    ethSwapped: t.bigint(),
    received111: t.bigint(),
    amount111: t.bigint(),
    // For mint/claim rows: which window ("claim" | "allowlist" | "public").
    mintPhase: t.text(),
    blockNumber: t.bigint().notNull(),
    blockTime: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    punkIdx: index().on(table.punkId, table.blockNumber),
    typeIdx: index().on(table.type, table.blockNumber),
  }),
)

// Single-row collection config, keyed on the contract address. Mirrors the
// on-chain owner-set schedule + fee knobs from ScheduleSet /
// AllowlistRootSet / MaxPerAllowlistedSet / FeeScheduleSet / ExitFeeSet.
// This is what lets the web read the phase schedule from Postgres instead
// of RPC. Fields are null until their setter event has fired.
export const homageConfig = onchainTable("homage_config", (t) => ({
  contract: t.hex().primaryKey(),
  claimStart: t.bigint(), // uint64 timestamps; 0/null = unscheduled/closed
  allowlistStart: t.bigint(),
  publicStart: t.bigint(),
  allowlistRoot: t.hex(),
  maxPerAllowlisted: t.bigint(),
  baseFee: t.bigint(),
  feeGrowthBps: t.bigint(),
  exitFee: t.bigint(),
  updatedAtBlock: t.bigint().notNull(),
  updatedAtTime: t.bigint().notNull(),
}))
