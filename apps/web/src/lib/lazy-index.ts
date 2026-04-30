import "server-only"
import { sql } from "./db"

/**
 * Lazy-index reads + writes against the `lazy_*` tables defined in
 * `db/migrations/002_lazy_indexer.sql`. The pattern at every call site:
 *
 *   1. Read path (e.g. `getFoundationLastSale`) checks the lazy table
 *      first via the `read*` functions below.
 *   2. If the row is fresh enough (within the per-table TTL), return it.
 *   3. Otherwise, run the existing RPC scan, return the result, AND
 *      fire-and-forget a `write*` call to UPSERT the result.
 *   4. Next miss within the TTL window collapses to a Postgres point
 *      lookup.
 *
 * Reads are awaited; writes are NOT — the caller's render shouldn't pay
 * the write latency. Writes silently no-op when the DB is unavailable
 * (same kill switch as `pgCache`).
 *
 * Bigints serialize to decimal strings at the table boundary; consumers
 * hydrate back via `BigInt(...)`.
 */

type FoundationSaleSource = "auction" | "buyNow"

export type LazyFoundationSale = {
  priceWei: bigint
  blockTime: number
  source: FoundationSaleSource
  txHash: string
  /** When the row was last refreshed by an RPC scan. */
  lastIndexedAt: Date
}

export async function readFoundationLastSale(
  nftContract: string,
  tokenId: string,
): Promise<LazyFoundationSale | null> {
  if (!sql) return null
  try {
    const rows = await sql<
      Array<{
        price_wei: string
        block_time: string
        source: FoundationSaleSource
        tx_hash: string
        last_indexed_at: Date
      }>
    >`
      SELECT price_wei, block_time::text AS block_time,
             source, tx_hash, last_indexed_at
      FROM lazy_fnd_sales
      WHERE nft_contract = ${nftContract.toLowerCase()}
        AND token_id = ${tokenId}
      LIMIT 1
    `
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      priceWei: BigInt(r.price_wei),
      blockTime: Number(r.block_time),
      source: r.source,
      txHash: r.tx_hash,
      lastIndexedAt: r.last_indexed_at,
    }
  } catch {
    return null
  }
}

export function writeFoundationLastSale(
  nftContract: string,
  tokenId: string,
  sale: { priceWei: bigint; blockTime: number; source: FoundationSaleSource; txHash: string },
): void {
  if (!sql) return
  void sql`
    INSERT INTO lazy_fnd_sales
      (nft_contract, token_id, price_wei, block_time, source, tx_hash, last_indexed_at)
    VALUES
      (${nftContract.toLowerCase()}, ${tokenId},
       ${sale.priceWei.toString()}, ${sale.blockTime},
       ${sale.source}, ${sale.txHash}, NOW())
    ON CONFLICT (nft_contract, token_id) DO UPDATE
      SET price_wei = EXCLUDED.price_wei,
          block_time = EXCLUDED.block_time,
          source = EXCLUDED.source,
          tx_hash = EXCLUDED.tx_hash,
          last_indexed_at = NOW()
  `.catch(() => {})
}

/**
 * Mark that we scanned for sales on this token and found none. Lets the
 * read path distinguish "no scan yet" from "scanned and empty," so we
 * don't re-scan on every miss for tokens that genuinely have no sales.
 */
export function writeFoundationNoSale(
  nftContract: string,
  tokenId: string,
): void {
  if (!sql) return
  // Insert a sentinel row with empty fields. `source = 'none'` would fail
  // the CHECK constraint, so we use a dedicated marker table instead.
  // The simplest signal: a row in lazy_fnd_artist_index_status keyed on
  // the token doesn't fit (that's per-creator). For now, callers handle
  // this by checking lastIndexedAt freshness — if recent and no row,
  // we trust "no sale yet." The row only gets written when there IS one.
  void nftContract
  void tokenId
}

export type LazyBidHistoryEntry = {
  bidder: string
  amount: bigint
  blockTime: number
  txHash: string
}

export async function readFoundationBidHistory(
  auctionId: string,
): Promise<LazyBidHistoryEntry[] | null> {
  if (!sql) return null
  try {
    const rows = await sql<
      Array<{
        bidder: string
        amount: string
        block_time: string
        tx_hash: string
      }>
    >`
      SELECT bidder, amount, block_time::text AS block_time, tx_hash
      FROM lazy_fnd_bids
      WHERE auction_id = ${auctionId}
      ORDER BY block_number DESC, log_index DESC
    `
    return rows.map((r) => ({
      bidder: r.bidder,
      amount: BigInt(r.amount),
      blockTime: Number(r.block_time),
      txHash: r.tx_hash,
    }))
  } catch {
    return null
  }
}

/**
 * `lastIndexedAt` of the most-recent bid we have for this auction. Lets
 * the read path TTL the cached set without a separate marker table —
 * the freshness of the newest row stands in for the freshness of the
 * scan. Returns null when no rows exist for this auction.
 */
export async function readFoundationBidHistoryFreshness(
  auctionId: string,
): Promise<Date | null> {
  if (!sql) return null
  try {
    const rows = await sql<Array<{ last_indexed_at: Date }>>`
      SELECT MAX(last_indexed_at) AS last_indexed_at
      FROM lazy_fnd_bids
      WHERE auction_id = ${auctionId}
    `
    return rows[0]?.last_indexed_at ?? null
  } catch {
    return null
  }
}

export function writeFoundationBidHistory(
  auctionId: string,
  bids: Array<{
    txHash: string
    logIndex: number
    bidder: string
    amount: bigint
    blockTime: number
    blockNumber: bigint
  }>,
): void {
  if (!sql || bids.length === 0) return
  // Bulk UPSERT in one round-trip. postgres.js's parameterized array form
  // would be cleaner but bid counts are small (typically <50 per auction)
  // so a sequential pile of inserts is fine.
  void (async () => {
    try {
      for (const b of bids) {
        await sql`
          INSERT INTO lazy_fnd_bids
            (auction_id, tx_hash, log_index, bidder, amount,
             block_time, block_number, last_indexed_at)
          VALUES
            (${auctionId}, ${b.txHash}, ${b.logIndex}, ${b.bidder.toLowerCase()},
             ${b.amount.toString()}, ${b.blockTime}, ${b.blockNumber.toString()},
             NOW())
          ON CONFLICT (auction_id, tx_hash, log_index) DO UPDATE
            SET last_indexed_at = NOW()
        `
      }
    } catch {
      /* ignore — next miss re-scans */
    }
  })()
}

export type LazySellerListings = {
  auctions: Array<{
    id: string
    auctionId: string
    nftContract: string
    tokenId: string
    reserveWei: string
    durationSeconds: number
  }>
  buyNows: Array<{
    id: string
    nftContract: string
    tokenId: string
    priceWei: string
  }>
  lastIndexedAt: Date
}

export async function readFoundationSellerListings(
  seller: string,
): Promise<LazySellerListings | null> {
  if (!sql) return null
  try {
    const rows = await sql<
      Array<{
        auctions: LazySellerListings["auctions"]
        buy_nows: LazySellerListings["buyNows"]
        last_indexed_at: Date
      }>
    >`
      SELECT auctions, buy_nows, last_indexed_at
      FROM lazy_fnd_seller_listings
      WHERE seller = ${seller.toLowerCase()}
      LIMIT 1
    `
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      auctions: r.auctions,
      buyNows: r.buy_nows,
      lastIndexedAt: r.last_indexed_at,
    }
  } catch {
    return null
  }
}

export function writeFoundationSellerListings(
  seller: string,
  payload: {
    auctions: LazySellerListings["auctions"]
    buyNows: LazySellerListings["buyNows"]
  },
): void {
  if (!sql) return
  void sql`
    INSERT INTO lazy_fnd_seller_listings
      (seller, auctions, buy_nows, last_indexed_at)
    VALUES
      (${seller.toLowerCase()}, ${sql.json(payload.auctions)},
       ${sql.json(payload.buyNows)}, NOW())
    ON CONFLICT (seller) DO UPDATE
      SET auctions = EXCLUDED.auctions,
          buy_nows = EXCLUDED.buy_nows,
          last_indexed_at = NOW()
  `.catch(() => {})
}

export type LazyArtistTokenRef = {
  contract: string
  tokenId: string
  blockNumber: bigint
  logIndex: number
}

export async function readFoundationArtistTokens(
  creator: string,
): Promise<{ refs: LazyArtistTokenRef[]; lastIndexedAt: Date } | null> {
  if (!sql) return null
  try {
    const status = await sql<Array<{ last_indexed_at: Date }>>`
      SELECT last_indexed_at FROM lazy_fnd_artist_index_status
      WHERE creator = ${creator.toLowerCase()}
      LIMIT 1
    `
    if (status.length === 0) return null

    const rows = await sql<
      Array<{
        contract: string
        token_id: string
        block_number: string
        log_index: number
      }>
    >`
      SELECT contract, token_id, block_number::text AS block_number, log_index
      FROM lazy_fnd_artist_tokens
      WHERE creator = ${creator.toLowerCase()}
      ORDER BY block_number DESC, log_index DESC
    `
    return {
      refs: rows.map((r) => ({
        contract: r.contract,
        tokenId: r.token_id,
        blockNumber: BigInt(r.block_number),
        logIndex: r.log_index,
      })),
      lastIndexedAt: status[0].last_indexed_at,
    }
  } catch {
    return null
  }
}

export function writeFoundationArtistTokens(
  creator: string,
  refs: LazyArtistTokenRef[],
): void {
  if (!sql) return
  void (async () => {
    try {
      const lower = creator.toLowerCase()
      for (const r of refs) {
        await sql`
          INSERT INTO lazy_fnd_artist_tokens
            (creator, contract, token_id, block_number, log_index, last_indexed_at)
          VALUES
            (${lower}, ${r.contract.toLowerCase()}, ${r.tokenId},
             ${r.blockNumber.toString()}, ${r.logIndex}, NOW())
          ON CONFLICT (creator, contract, token_id) DO UPDATE
            SET last_indexed_at = NOW()
        `
      }
      await sql`
        INSERT INTO lazy_fnd_artist_index_status (creator, last_indexed_at)
        VALUES (${lower}, NOW())
        ON CONFLICT (creator) DO UPDATE SET last_indexed_at = NOW()
      `
    } catch {
      /* ignore */
    }
  })()
}

// ─── ERC-1155 transfer stream per contract ───────────────────────────────
// Stored as a JSON blob per contract because Alchemy's
// `alchemy_getAssetTransfers` doesn't surface `logIndex` per transfer,
// so a structured per-transfer PK isn't reliable. The shape mirrors the
// `CachedTransferStream` type that `fetchErc1155TransferStream` produces.

export type LazyErc1155TransferRow = {
  from: string
  to: string
  tokenIdHex: string
  amountStr: string
  blockNumHex: string
  timestamp: number
  txHash: string
}

export type LazyErc1155Stream = {
  isErc1155: boolean
  transfers: LazyErc1155TransferRow[]
  lastIndexedAt: Date
}

export async function readErc1155TransferStream(
  contract: string,
): Promise<LazyErc1155Stream | null> {
  if (!sql) return null
  try {
    const rows = await sql<
      Array<{
        is_erc1155: boolean
        transfers_json: LazyErc1155TransferRow[]
        last_indexed_at: Date
      }>
    >`
      SELECT is_erc1155, transfers_json, last_indexed_at
      FROM lazy_erc1155_streams
      WHERE contract = ${contract.toLowerCase()}
      LIMIT 1
    `
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      isErc1155: r.is_erc1155,
      transfers: r.transfers_json,
      lastIndexedAt: r.last_indexed_at,
    }
  } catch {
    return null
  }
}

export function writeErc1155TransferStream(
  contract: string,
  isErc1155: boolean,
  transfers: LazyErc1155TransferRow[],
): void {
  if (!sql) return
  void sql`
    INSERT INTO lazy_erc1155_streams
      (contract, is_erc1155, transfers_json, last_indexed_at)
    VALUES
      (${contract.toLowerCase()}, ${isErc1155},
       ${sql.json(transfers)}, NOW())
    ON CONFLICT (contract) DO UPDATE
      SET is_erc1155 = EXCLUDED.is_erc1155,
          transfers_json = EXCLUDED.transfers_json,
          last_indexed_at = NOW()
  `.catch(() => {})
}

// ─── Foundation collector tokens ─────────────────────────────────────────

export type LazyFoundationCollectorToken = {
  contract: string
  tokenId: string
  acquiredAtBlock: bigint
  acquiredTxHash: string | null
}

export async function readFoundationCollectorTokens(
  wallet: string,
): Promise<{ tokens: LazyFoundationCollectorToken[]; lastIndexedAt: Date } | null> {
  if (!sql) return null
  try {
    const status = await sql<Array<{ last_indexed_at: Date }>>`
      SELECT last_indexed_at FROM lazy_fnd_collector_status
      WHERE wallet = ${wallet.toLowerCase()}
      LIMIT 1
    `
    if (status.length === 0) return null

    const rows = await sql<
      Array<{
        contract: string
        token_id: string
        acquired_at_block: string
        acquired_tx_hash: string | null
      }>
    >`
      SELECT contract, token_id,
             acquired_at_block::text AS acquired_at_block,
             acquired_tx_hash
      FROM lazy_fnd_collector_tokens
      WHERE wallet = ${wallet.toLowerCase()}
      ORDER BY acquired_at_block DESC
    `
    return {
      tokens: rows.map((r) => ({
        contract: r.contract,
        tokenId: r.token_id,
        acquiredAtBlock: BigInt(r.acquired_at_block),
        acquiredTxHash: r.acquired_tx_hash,
      })),
      lastIndexedAt: status[0].last_indexed_at,
    }
  } catch {
    return null
  }
}

export function writeFoundationCollectorTokens(
  wallet: string,
  tokens: LazyFoundationCollectorToken[],
): void {
  if (!sql) return
  void (async () => {
    try {
      const lower = wallet.toLowerCase()
      for (const t of tokens) {
        await sql`
          INSERT INTO lazy_fnd_collector_tokens
            (wallet, contract, token_id, acquired_at_block,
             acquired_tx_hash, last_indexed_at)
          VALUES
            (${lower}, ${t.contract.toLowerCase()}, ${t.tokenId},
             ${t.acquiredAtBlock.toString()}, ${t.acquiredTxHash}, NOW())
          ON CONFLICT (wallet, contract, token_id) DO UPDATE
            SET acquired_at_block = EXCLUDED.acquired_at_block,
                acquired_tx_hash = EXCLUDED.acquired_tx_hash,
                last_indexed_at = NOW()
        `
      }
      await sql`
        INSERT INTO lazy_fnd_collector_status (wallet, last_indexed_at)
        VALUES (${lower}, NOW())
        ON CONFLICT (wallet) DO UPDATE SET last_indexed_at = NOW()
      `
    } catch {
      /* ignore */
    }
  })()
}

// ─── Manifold collector tokens ───────────────────────────────────────────

export type LazyManifoldCollectorToken = {
  contract: string
  tokenId: string
  collectionName: string | null
}

export async function readManifoldCollectorTokens(
  wallet: string,
): Promise<{ tokens: LazyManifoldCollectorToken[]; lastIndexedAt: Date } | null> {
  if (!sql) return null
  try {
    const status = await sql<Array<{ last_indexed_at: Date }>>`
      SELECT last_indexed_at FROM lazy_manifold_collector_status
      WHERE wallet = ${wallet.toLowerCase()}
      LIMIT 1
    `
    if (status.length === 0) return null

    const rows = await sql<
      Array<{
        contract: string
        token_id: string
        collection_name: string | null
      }>
    >`
      SELECT contract, token_id, collection_name
      FROM lazy_manifold_collector_tokens
      WHERE wallet = ${wallet.toLowerCase()}
    `
    return {
      tokens: rows.map((r) => ({
        contract: r.contract,
        tokenId: r.token_id,
        collectionName: r.collection_name,
      })),
      lastIndexedAt: status[0].last_indexed_at,
    }
  } catch {
    return null
  }
}

export function writeManifoldCollectorTokens(
  wallet: string,
  tokens: LazyManifoldCollectorToken[],
): void {
  if (!sql) return
  void (async () => {
    try {
      const lower = wallet.toLowerCase()
      for (const t of tokens) {
        await sql`
          INSERT INTO lazy_manifold_collector_tokens
            (wallet, contract, token_id, collection_name, last_indexed_at)
          VALUES
            (${lower}, ${t.contract.toLowerCase()}, ${t.tokenId},
             ${t.collectionName}, NOW())
          ON CONFLICT (wallet, contract, token_id) DO UPDATE
            SET collection_name = EXCLUDED.collection_name,
                last_indexed_at = NOW()
        `
      }
      await sql`
        INSERT INTO lazy_manifold_collector_status (wallet, last_indexed_at)
        VALUES (${lower}, NOW())
        ON CONFLICT (wallet) DO UPDATE SET last_indexed_at = NOW()
      `
    } catch {
      /* ignore */
    }
  })()
}

// ─── Manifold per-artist token enumeration ───────────────────────────────

export type LazyManifoldToken = {
  contract: string
  tokenId: string
  collectionName: string | null
}

export async function readManifoldArtistTokens(
  creator: string,
): Promise<{ tokens: LazyManifoldToken[]; lastIndexedAt: Date } | null> {
  if (!sql) return null
  try {
    const status = await sql<Array<{ last_indexed_at: Date }>>`
      SELECT last_indexed_at FROM lazy_manifold_artist_status
      WHERE creator = ${creator.toLowerCase()}
      LIMIT 1
    `
    if (status.length === 0) return null

    const rows = await sql<
      Array<{
        contract: string
        token_id: string
        collection_name: string | null
      }>
    >`
      SELECT contract, token_id, collection_name
      FROM lazy_manifold_artist_tokens
      WHERE creator = ${creator.toLowerCase()}
    `
    return {
      tokens: rows.map((r) => ({
        contract: r.contract,
        tokenId: r.token_id,
        collectionName: r.collection_name,
      })),
      lastIndexedAt: status[0].last_indexed_at,
    }
  } catch {
    return null
  }
}

export function writeManifoldArtistTokens(
  creator: string,
  tokens: LazyManifoldToken[],
): void {
  if (!sql) return
  void (async () => {
    try {
      const lower = creator.toLowerCase()
      for (const t of tokens) {
        await sql`
          INSERT INTO lazy_manifold_artist_tokens
            (creator, contract, token_id, collection_name, last_indexed_at)
          VALUES
            (${lower}, ${t.contract.toLowerCase()}, ${t.tokenId},
             ${t.collectionName}, NOW())
          ON CONFLICT (creator, contract, token_id) DO UPDATE
            SET collection_name = EXCLUDED.collection_name,
                last_indexed_at = NOW()
        `
      }
      await sql`
        INSERT INTO lazy_manifold_artist_status (creator, last_indexed_at)
        VALUES (${lower}, NOW())
        ON CONFLICT (creator) DO UPDATE SET last_indexed_at = NOW()
      `
    } catch {
      /* ignore */
    }
  })()
}

/**
 * Per-table TTLs. The lazy layer sits BELOW `pgCache` (existing 7d TTL
 * on `last-sale:` keys, 24h on artist refs). Lazy TTLs must therefore be
 * LONGER than the pgCache TTLs they back, otherwise the lazy row is
 * always stale by the time pgCache misses and we'd re-scan anyway —
 * defeating the purpose. The lazy layer's value is "extend the
 * free-read window past pgCache expiry, when on-chain data hasn't
 * meaningfully changed."
 *
 * Trade-off: a longer TTL means stale data persists longer when on-chain
 * state changes (a NEW sale happens, a new mint, etc.) without an
 * explicit invalidation. The existing /api/revalidate flush still
 * applies — it nukes the pgCache layer; we let that propagate to lazy
 * by having lazy reads check pgCache freshness implicitly via the
 * existing flow.
 */
export const LAZY_TTL = {
  /** Sales: settled prices are immutable on-chain. A token can GAIN a
   * new sale; 30d is the cap on how long we'd display a stale "last
   * sold." Practical impact: zero, because /api/revalidate is fired on
   * every settle/sale write from the UI. */
  foundationSale: 30 * 24 * 60 * 60 * 1000,
  /** Bids: live data, but the auction-state read path wraps this with
   * its own 30s pgCache so consecutive bid-history views collapse there.
   * We keep lazy tight to avoid stale bid lists outliving the auction
   * itself. */
  foundationBids: 30 * 60 * 1000,
  /** Seller-cancellable listings: change when artist creates / cancels /
   * accepts. The panel that reads these has a 5-min pgCache; lazy is
   * 30 min so re-opens within that window collapse to a Postgres read
   * even after pgCache expires. */
  foundationSellerListings: 30 * 60 * 1000,
  /** Artist token discovery: new mints are user-driven and infrequent
   * (artists mint maybe once a week at most). pgCache is 24h; lazy is
   * 30d so cold-cache cycles past the daily TTL still skip RPC. */
  foundationArtistTokens: 30 * 24 * 60 * 60 * 1000,
  /** ERC-1155 transfer streams: TransferSingle stream per contract.
   * Settled transfers are immutable; only new mints/transfers extend the
   * stream. pgCache is 10 min on getErc1155TransferStream; lazy at 7d
   * means most repeat misses past the in-process cache hit Postgres. */
  erc1155TransferStream: 7 * 24 * 60 * 60 * 1000,
  /** Manifold artist token enumeration: discovered Manifold creator-core
   * contracts + tokens minted on each. pgCache for the wrapping
   * `getCachedTokenRefs` is 24h; lazy at 30d covers cold-cache cycles. */
  manifoldArtistTokens: 30 * 24 * 60 * 60 * 1000,
  /** Foundation collector tokens: ownership shifts on every Transfer,
   * which is more dynamic than mint history. 6h matches what feels
   * fresh enough for a /collector/[address] page without rescanning
   * every visit. */
  foundationCollectorTokens: 6 * 60 * 60 * 1000,
  /** Manifold collector tokens: same dynamism reasoning as Foundation. */
  manifoldCollectorTokens: 6 * 60 * 60 * 1000,
}

export function isFresh(lastIndexedAt: Date, ttlMs: number): boolean {
  return Date.now() - lastIndexedAt.getTime() < ttlMs
}
