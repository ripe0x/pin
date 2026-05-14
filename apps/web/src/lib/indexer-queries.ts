import "server-only"
import { sql } from "./db"

/**
 * Read-side queries against the tables Ponder writes (`pnd_auctions`,
 * `pnd_bids`). Lives next to `pgCache` because both share the same
 * Postgres connection — we don't need a separate GraphQL client.
 *
 * Every export has a hard timeout and returns `null` on miss / failure.
 * Callers fall through to the cached RPC path on null. That makes the
 * indexer additive: when Ponder hasn't synced yet, when the database is
 * unreachable, when we explicitly disable it, the app behaves exactly as
 * it does on the cache+RPC layers.
 *
 * **Kill switch.** Three layers:
 *   1. `DATABASE_URL` unset → `sql` is null → these all return null.
 *   2. `INDEXER_DISABLED=1` → these all return null even when DB is up.
 *   3. Per-query timeout (500ms) → slow indexer reads bail to RPC fallback.
 */

const INDEXER_DISABLED = process.env.INDEXER_DISABLED === "1"

/**
 * Thrown by callers wrapping an indexer read in `unstable_cache` when
 * the read is unavailable (timeout, DB down, kill switch). Throwing
 * — rather than returning `null` from the cached function — keeps
 * `unstable_cache` from persisting the failure, so the next request
 * retries fresh instead of serving the bad value for the full TTL.
 */
export class IndexerUnavailable extends Error {
  constructor(message = "indexer unavailable") {
    super(message)
    this.name = "IndexerUnavailable"
  }
}

// Per-query default; overridable via the `withTimeout` second arg. Home-
// page reads (square + counters) pass 2_000 because they're below the hero
// behind Suspense, where a cold-Postgres-read of ~1s is acceptable; per-
// token reads use this default so a slow indexer can't add latency to the
// primary render.
const QUERY_TIMEOUT_MS = 500

/**
 * Race a query against a timeout. Returns `null` if the query exceeds
 * `timeoutMs` so we don't add latency to renders when the indexer is
 * slow / unreachable / not yet synced.
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Number of active PND auctions (status = 'active') for a given seller.
 * Maps directly to `getActiveAuctionCount` in `apps/web/src/lib/auctions.ts`.
 *
 * Returns `null` if the indexer is unavailable / disabled / slow — the
 * caller treats that as "fall back to RPC".
 */
export type SettledAuctionBid = {
  bidder: string
  bidderDisplay: string
  amount: bigint
  blockTime: number
  txHash: string
}

export type SettledAuction = {
  seller: string
  sellerDisplay: string
  winner: string
  winnerDisplay: string
  amount: bigint
  settledAtTime: number
  bids: SettledAuctionBid[]
}

export async function getSettledAuctionForToken(
  tokenContract: string,
  tokenId: string,
): Promise<SettledAuction | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const contract = tokenContract.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT id, seller, winner, amount::text AS amount,
              settled_at_time::text AS settled_at_time
       FROM ${schema}.pnd_auctions
       WHERE token_contract = $1
         AND token_id = $2::numeric
         AND status = 'settled'
       ORDER BY settled_at_time DESC
       LIMIT 1`,
      [contract, tokenId],
    )) as Array<{
      id: string
      seller: string
      winner: string
      amount: string
      settled_at_time: string
    }>

    if (rows.length === 0) return null
    const row = rows[0]

    const bidRows = (await db.unsafe(
      `SELECT bidder, amount::text AS amount,
              block_time::text AS block_time, tx_hash
       FROM ${schema}.pnd_bids
       WHERE auction_id = $1
       ORDER BY block_number DESC`,
      [row.id],
    )) as Array<{
      bidder: string
      amount: string
      block_time: string
      tx_hash: string
    }>

    return {
      seller: row.seller,
      sellerDisplay: row.seller,
      winner: row.winner ?? "",
      winnerDisplay: row.winner ?? "",
      amount: BigInt(row.amount),
      settledAtTime: Number(row.settled_at_time),
      bids: bidRows.map((b) => ({
        bidder: b.bidder,
        bidderDisplay: b.bidder,
        amount: BigInt(b.amount),
        blockTime: Number(b.block_time),
        txHash: b.tx_hash,
      })),
    }
  })
}

export type ActivePndAuction = {
  house: string
  tokenContract: string
  tokenId: string
  seller: string
  amount: bigint
  reservePrice: bigint
  endTime: number
  firstBidTime: number
  createdAtTime: number
}

/**
 * Currently-active PND auctions across every Sovereign Auction House,
 * ordered ending-soonest-first with pre-bid auctions (endTime = 0) at the
 * end. Powers the home-page square.
 */
export async function getActivePndAuctions(
  limit = 12,
): Promise<ActivePndAuction[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  // Longer timeout than the per-token reads: the home-page square renders
  // in a Suspense boundary below the hero, so paying ~700ms-1s on the
  // first uncached load is fine. The hero still streams immediately.
  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT house, token_contract, token_id::text AS token_id, seller,
              amount::text AS amount, reserve_price::text AS reserve_price,
              end_time::text AS end_time,
              first_bid_time::text AS first_bid_time,
              created_at_time::text AS created_at_time
       FROM ${schema}.pnd_auctions
       WHERE status = 'active'
       ORDER BY
         CASE WHEN end_time = 0 THEN 1 ELSE 0 END,
         end_time ASC
       LIMIT $1`,
      [limit],
    )) as Array<{
      house: string
      token_contract: string
      token_id: string
      seller: string
      amount: string
      reserve_price: string
      end_time: string
      first_bid_time: string
      created_at_time: string
    }>

    return rows.map((r) => ({
      house: r.house,
      tokenContract: r.token_contract,
      tokenId: r.token_id,
      seller: r.seller,
      amount: BigInt(r.amount),
      reservePrice: BigInt(r.reserve_price),
      endTime: Number(r.end_time),
      firstBidTime: Number(r.first_bid_time),
      createdAtTime: Number(r.created_at_time),
    }))
  }, 2_000)
}

export type PndHouse = {
  house: string
  owner: string
  createdAtTime: number
}

/**
 * Houses deployed through the SovereignAuctionHouseFactory, newest first.
 * Includes houses that have no listings yet — the row is written when the
 * factory emits `AuctionHouseCreated`, before any auction exists.
 */
export async function getPndHouses(limit = 24): Promise<PndHouse[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT house, owner, created_at_time::text AS created_at_time
       FROM ${schema}.pnd_houses
       ORDER BY created_at_time DESC
       LIMIT $1`,
      [limit],
    )) as Array<{ house: string; owner: string; created_at_time: string }>

    return rows.map((r) => ({
      house: r.house,
      owner: r.owner,
      createdAtTime: Number(r.created_at_time),
    }))
  }, 2_000)
}

export type PlatformStats = {
  housesDeployed: number
  ethSettledWei: bigint
}

/**
 * Aggregate platform totals for the home-page ambient counters.
 * Returns null when the indexer is unavailable; the caller hides the
 * counters sentence entirely in that case.
 */
export async function getPlatformStats(): Promise<PlatformStats | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const [houseRows, settledRows] = await Promise.all([
      db.unsafe(
        `SELECT COUNT(*)::text AS count FROM ${schema}.pnd_houses`,
      ) as Promise<Array<{ count: string }>>,
      db.unsafe(
        `SELECT COALESCE(
            SUM(seller_proceeds + protocol_fee), 0
          )::text AS total
         FROM ${schema}.pnd_auctions
         WHERE status = 'settled'`,
      ) as Promise<Array<{ total: string }>>,
    ])

    return {
      housesDeployed: Number(houseRows[0]?.count ?? 0),
      ethSettledWei: BigInt(settledRows[0]?.total ?? "0"),
    }
  }, 2_000)
}


// ─── Foundation artist token pre-filter ──────────────────────────────────
//
// Used by `discoverFoundationArtistRefs` to short-circuit the expensive
// 6-call eth_getLogs scan when Ponder already has the answer. Critical
// for crawler protection: search-engine bots walking `/artist/<addr>`
// links from the activity feed used to trigger eager Foundation scans
// against ~13M blocks of chain history per address. With Ponder
// indexing FND, a creator's tokens are a Postgres point lookup.

export type IndexerFoundationTokenRef = {
  contract: string
  tokenId: string
  blockNumber: bigint
  logIndex: number
}

/**
 * Foundation tokens minted by `creator` per Ponder. Returns null when
 * the indexer is unavailable / disabled / slow so callers fall back to
 * the existing lazy + RPC path. Returns `[]` when Ponder is healthy and
 * the creator legitimately has no Foundation tokens since the indexer's
 * startBlock — caller treats `[]` as a positive "I have an answer" hit
 * (skip eager scan).
 *
 * Caveat: Ponder's startBlock is the same as PND's (~Nov 2025). Creators
 * with only pre-startBlock activity will return `[]` here even though
 * they're real Foundation creators. The caller can decide whether to
 * trust the empty answer or fall through to the full eager scan; today
 * the caller chooses to trust it for cost-protection reasons (the
 * lazy_fnd_artist_index_status 30-day TTL on negative answers is
 * preserved for the rare case it's needed).
 */
export async function getFoundationTokensFromIndexer(
  creator: string,
): Promise<IndexerFoundationTokenRef[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT contract,
              token_id::text AS token_id,
              block_number::text AS block_number,
              log_index
         FROM ${schema}.fnd_artist_tokens
        WHERE creator = $1
        ORDER BY block_number DESC, log_index DESC`,
      [creator.toLowerCase()],
    )) as Array<{
      contract: string
      token_id: string
      block_number: string
      log_index: number
    }>

    return rows.map((r) => ({
      contract: r.contract,
      tokenId: r.token_id,
      blockNumber: BigInt(r.block_number),
      logIndex: r.log_index,
    }))
  })
}

// ─── Activity feed ────────────────────────────────────────────────────────
//
// One reverse-chronological stream of "sovereign actions" — events whose
// grammatical subject is the artist (deploy, list, mint, settle), plus
// first-bid events on their auctions. Powers the v2 home page.

export type ActivityKind =
  | "house.deployed"
  | "collection.deployed"
  | "auction.opened"
  | "auction.firstBid"
  | "auction.bid"
  | "auction.settled"
  | "auction.cancelled"
  | "sale.buyNow"
  | "mint"

export type ActivityEvent = {
  id: string
  kind: ActivityKind
  blockTime: number
  /** The address that's the *subject* of the row (seller / deployer / minter). */
  artist: string
  /** The other party, when relevant (winner, bidder, buyer). */
  counterparty: string | null
  tokenContract: string | null
  tokenId: string | null
  amountWei: bigint | null
  reserveWei: bigint | null
  endTime: number | null
  house: string | null
  collection: string | null
  collectionName: string | null
  /** The transaction hash that produced this event, when the indexer
   * stores one. Available for bids, FND sales, and FND auction
   * settlements; `null` for PND settlements / house & collection
   * deployments / mints (those tables don't carry a tx hash today). */
  txHash: string | null
}

/**
 * Recent sovereign actions across both contract families, normalized to a
 * single shape and sorted newest-first. Each subquery is independently
 * bounded with `ORDER BY <time> DESC LIMIT 100` so the merge sorts at most
 * a few hundred rows even before any composite-time index exists.
 *
 * Returns `null` on indexer-unavailable so callers can hide the feed
 * rather than show a half-broken page.
 */
/**
 * Keyset cursor for `getActivityFeed`. The feed sorts by
 * `(blockTime DESC, id DESC)` — events in the same block share a
 * blockTime, so `id` is the tiebreaker. To page, the caller passes
 * the last row's `(blockTime, id)` and we return the next slice.
 *
 * The unioned subquery shape means we can't keyset-paginate inside
 * each branch (each branch has a distinct ORDER BY). Instead we widen
 * `PER_SUBQUERY_LIMIT` per page so the merged candidate pool covers
 * the requested cursor range, then filter+sort+limit at the outer
 * query. For `limit ≤ 50` this stays under a few hundred rows of
 * scan per page.
 */
export type ActivityCursor = {
  blockTime: number
  id: string
}

export async function getActivityFeed(
  limit = 50,
  cursor: ActivityCursor | null = null,
  timeoutMs = 3_000,
): Promise<ActivityEvent[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    type Row = {
      kind: ActivityKind
      id: string
      block_time: string
      artist: string
      counterparty: string | null
      token_contract: string | null
      token_id: string | null
      amount: string | null
      reserve: string | null
      end_time: string | null
      house: string | null
      collection: string | null
      collection_name: string | null
      tx_hash: string | null
    }

    const PER_SUBQUERY_LIMIT = 100

    // Filter listing/cancellation pairs that happened within 15 minutes
    // of each other. Treated as noise (test mints, mistaken listings)
    // rather than signal. Both events filter together so the feed
    // doesn't show one half of the pair.
    const SHORT_LIFE_SECONDS = 900
    const PND_NOT_QUICK_CANCEL = `NOT (status = 'cancelled' AND settled_at_time IS NOT NULL AND settled_at_time - created_at_time < ${SHORT_LIFE_SECONDS})`
    const FND_NOT_QUICK_CANCEL = `NOT (status = 'canceled' AND finalized_at_time IS NOT NULL AND finalized_at_time - created_at_time < ${SHORT_LIFE_SECONDS})`
    const PND_LONG_LIVED_CANCEL = `status = 'cancelled' AND settled_at_time IS NOT NULL AND settled_at_time - created_at_time >= ${SHORT_LIFE_SECONDS}`

    // Cursor-aware branch filters. Each branch limits to its top-N
    // strictly-older-than-cursor rows; the outer query enforces the
    // (blockTime, id) tiebreak globally. Without the per-branch
    // filter, deep pages would starve branches whose top-100 rows
    // all sit above the cursor.
    const cursorTime = cursor?.blockTime ?? null
    const cursorId = cursor?.id ?? null
    const branchFilter = (timeCol: string) =>
      cursor ? `AND ${timeCol} <= $2::numeric` : ""
    // The settled subquery already has a WHERE clause; everything
    // else needs `WHERE 1=1` as a prefix so we can append AND-clauses
    // unconditionally.
    const where = (existing: string | null, timeCol: string) => {
      const branch = branchFilter(timeCol)
      if (!branch) return existing ? `WHERE ${existing}` : ""
      return existing ? `WHERE ${existing} ${branch}` : `WHERE 1=1 ${branch}`
    }

    const rows = (await db.unsafe(
      `WITH events AS (
         (SELECT
            'house.deployed'::text AS kind,
            ('house:' || house)::text AS id,
            created_at_time::text AS block_time,
            owner::text AS artist,
            NULL::text AS counterparty,
            NULL::text AS token_contract,
            NULL::text AS token_id,
            NULL::text AS amount,
            NULL::text AS reserve,
            NULL::text AS end_time,
            house::text AS house,
            NULL::text AS collection,
            NULL::text AS collection_name,
            created_tx_hash::text AS tx_hash
          FROM ${schema}.pnd_houses
          ${where(null, "created_at_time")}
          ORDER BY created_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'collection.deployed'::text,
            ('coll:' || collection)::text,
            created_at_time::text,
            creator::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            collection::text,
            name,
            NULL::text
          FROM ${schema}.fnd_collections
          ${where(null, "created_at_time")}
          ORDER BY created_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'auction.opened'::text,
            ('pnd-open:' || id)::text,
            created_at_time::text,
            seller::text,
            NULL::text,
            token_contract::text,
            token_id::text,
            NULL::text,
            reserve_price::text,
            NULLIF(end_time, 0)::text,
            house::text,
            NULL::text,
            NULL::text,
            created_tx_hash::text
          FROM ${schema}.pnd_auctions
          ${where(PND_NOT_QUICK_CANCEL, "created_at_time")}
          ORDER BY created_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'auction.opened'::text,
            ('fnd-open:' || auction_id)::text,
            created_at_time::text,
            seller::text,
            NULL::text,
            nft_contract::text,
            token_id::text,
            NULL::text,
            reserve_price::text,
            NULLIF(end_time, 0)::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text
          FROM ${schema}.fnd_auctions
          ${where(FND_NOT_QUICK_CANCEL, "created_at_time")}
          ORDER BY created_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'auction.settled'::text,
            ('pnd-settle:' || id)::text,
            settled_at_time::text,
            seller::text,
            winner::text,
            token_contract::text,
            token_id::text,
            amount::text,
            NULL::text,
            NULL::text,
            house::text,
            NULL::text,
            NULL::text,
            lifecycle_tx_hash::text
          FROM ${schema}.pnd_auctions
          ${where("status = 'settled' AND settled_at_time IS NOT NULL", "settled_at_time")}
          ORDER BY settled_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'auction.cancelled'::text,
            ('pnd-cancel:' || id)::text,
            settled_at_time::text,
            seller::text,
            NULL::text,
            token_contract::text,
            token_id::text,
            NULL::text,
            reserve_price::text,
            NULL::text,
            house::text,
            NULL::text,
            NULL::text,
            lifecycle_tx_hash::text
          FROM ${schema}.pnd_auctions
          ${where(PND_LONG_LIVED_CANCEL, "settled_at_time")}
          ORDER BY settled_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            CASE WHEN source = 'auction'
                 THEN 'auction.settled'
                 ELSE 'sale.buyNow' END,
            ('sale:' || id)::text,
            block_time::text,
            seller::text,
            buyer::text,
            nft_contract::text,
            token_id::text,
            price_wei::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            tx_hash::text
          FROM ${schema}.fnd_sales
          ${where(null, "block_time")}
          ORDER BY block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'mint'::text,
            ('mint:' || id)::text,
            block_time::text,
            creator::text,
            NULL::text,
            contract::text,
            token_id::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text
          FROM ${schema}.fnd_artist_tokens
          ${where(null, "block_time")}
          ORDER BY block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            (CASE WHEN pb.first_bid THEN 'auction.firstBid'
                  ELSE 'auction.bid' END)::text,
            ('pnd-bid:' || pb.id)::text,
            pb.block_time::text,
            pa.seller::text,
            pb.bidder::text,
            pa.token_contract::text,
            pa.token_id::text,
            pb.amount::text,
            NULL::text,
            NULLIF(pa.end_time, 0)::text,
            pa.house::text,
            NULL::text,
            NULL::text,
            pb.tx_hash::text
          FROM ${schema}.pnd_bids pb
          JOIN ${schema}.pnd_auctions pa ON pa.id = pb.auction_id
          ${where(null, "pb.block_time")}
          ORDER BY pb.block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            (CASE WHEN sub.rn = 1 THEN 'auction.firstBid'
                  ELSE 'auction.bid' END)::text,
            ('fnd-bid:' || sub.id)::text,
            sub.block_time::text,
            fa.seller::text,
            sub.bidder::text,
            fa.nft_contract::text,
            fa.token_id::text,
            sub.amount::text,
            NULL::text,
            NULLIF(sub.end_time, 0)::text,
            NULL::text,
            NULL::text,
            NULL::text,
            sub.tx_hash::text
          FROM (
            SELECT id, auction_id, bidder, amount, end_time, block_time, tx_hash,
                   ROW_NUMBER() OVER (
                     PARTITION BY auction_id ORDER BY block_number
                   ) AS rn
            FROM ${schema}.fnd_bids
          ) sub
          JOIN ${schema}.fnd_auctions fa ON fa.auction_id = sub.auction_id
          ${where(null, "sub.block_time")}
          ORDER BY sub.block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})
       )
       SELECT * FROM events
       ${
         cursor
           ? `WHERE (block_time::numeric < $2::numeric
                     OR (block_time::numeric = $2::numeric AND id < $3))`
           : ""
       }
       ORDER BY block_time::numeric DESC, id DESC
       LIMIT $1`,
      cursor ? [limit, cursorTime, cursorId] : [limit],
    )) as Row[]

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      blockTime: Number(r.block_time),
      artist: r.artist,
      counterparty: r.counterparty,
      tokenContract: r.token_contract,
      tokenId: r.token_id,
      amountWei: r.amount === null ? null : BigInt(r.amount),
      reserveWei: r.reserve === null ? null : BigInt(r.reserve),
      endTime: r.end_time === null ? null : Number(r.end_time),
      house: r.house,
      collection: r.collection,
      collectionName: r.collection_name,
      txHash: r.tx_hash,
    }))
  }, timeoutMs)
}

// ─── Dependency-check helpers ────────────────────────────────────────────
//
// Used by `apps/web/src/lib/dependency-check.ts` to assemble the scan
// report at `/api/dependency/[address]`. All four are point lookups
// against existing indexes (`fnd_auctions.seller_status`, `fnd_buy_nows
// .seller_status`, `fnd_artist_tokens.creator`, `fnd_collections.creator`,
// `fnd_sales` filtered on `seller`).

export async function getActiveFndAuctionCount(
  sellerAddress: string,
): Promise<number | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const seller = sellerAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT COUNT(*)::text AS count
         FROM ${schema}.fnd_auctions
        WHERE seller = $1 AND status = 'active'`,
      [seller],
    )) as Array<{ count: string }>
    return Number(rows[0]?.count ?? 0)
  }, 2_000)
}

export async function getActiveFndBuyNowCount(
  sellerAddress: string,
): Promise<number | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const seller = sellerAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT COUNT(*)::text AS count
         FROM ${schema}.fnd_buy_nows
        WHERE seller = $1 AND status = 'active'`,
      [seller],
    )) as Array<{ count: string }>
    return Number(rows[0]?.count ?? 0)
  }, 2_000)
}

export type FoundationCreatorSummary = {
  tokenCount: number
  collectionCount: number
}

/**
 * Counts of Foundation tokens minted by an artist and per-artist
 * collection contracts they've deployed. Combines both contract families
 * (shared FoundationNFT contract + per-artist clones from the V1/V2
 * factories).
 */
export async function getFoundationCreatorSummary(
  artistAddress: string,
): Promise<FoundationCreatorSummary | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const creator = artistAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const [tokenRows, collectionRows] = await Promise.all([
      db.unsafe(
        `SELECT COUNT(*)::text AS count
           FROM ${schema}.fnd_artist_tokens
          WHERE creator = $1`,
        [creator],
      ) as Promise<Array<{ count: string }>>,
      db.unsafe(
        `SELECT COUNT(*)::text AS count
           FROM ${schema}.fnd_collections
          WHERE creator = $1`,
        [creator],
      ) as Promise<Array<{ count: string }>>,
    ])
    return {
      tokenCount: Number(tokenRows[0]?.count ?? 0),
      collectionCount: Number(collectionRows[0]?.count ?? 0),
    }
  }, 2_000)
}

export type FoundationSalesSummary = {
  saleCount: number
  /** True when this seller has any settled Foundation sale on record. */
  hasFoundation: boolean
}

/**
 * Settled Foundation sales (auctions + buy-nows) where this address was
 * the seller. Drives the "sale paths observed" card — Foundation is the
 * one platform PND fully indexes today; the other marketplaces come
 * from the seller-listings adapter in chip 2.
 */
export async function getFoundationSalesSummary(
  sellerAddress: string,
): Promise<FoundationSalesSummary | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const seller = sellerAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT COUNT(*)::text AS count
         FROM ${schema}.fnd_sales
        WHERE seller = $1`,
      [seller],
    )) as Array<{ count: string }>
    const saleCount = Number(rows[0]?.count ?? 0)
    return { saleCount, hasFoundation: saleCount > 0 }
  }, 2_000)
}

export type ArtistContractRow = {
  contract: string
  tokenCount: number
  /** Set when the contract has a row in `fnd_collections` (i.e. it was
   * deployed via the V1/V2 factories). The classifier compares this to
   * the scanned artist address to decide artist-owned vs shared. */
  collectionCreator: string | null
  collectionKind: string | null
  collectionName: string | null
  collectionSymbol: string | null
}

/**
 * Per-contract token counts for an artist, joined with the
 * `fnd_collections` row when one exists. The classifier in
 * `contract-classifier.ts` turns these rows into typed map entries for
 * the Artist Dependency Report.
 *
 * Returns null on indexer-unavailable so the caller can render an
 * "Unable to check" state for the contract-map section rather than
 * failing the whole report.
 */
export async function getArtistContractMap(
  artistAddress: string,
): Promise<ArtistContractRow[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const creator = artistAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT
         t.contract,
         COUNT(*)::int AS token_count,
         c.creator AS collection_creator,
         c.kind   AS collection_kind,
         c.name   AS collection_name,
         c.symbol AS collection_symbol
       FROM ${schema}.fnd_artist_tokens t
       LEFT JOIN ${schema}.fnd_collections c
              ON c.collection = t.contract
       WHERE t.creator = $1
       GROUP BY t.contract, c.creator, c.kind, c.name, c.symbol
       ORDER BY COUNT(*) DESC`,
      [creator],
    )) as Array<{
      contract: string
      token_count: number
      collection_creator: string | null
      collection_kind: string | null
      collection_name: string | null
      collection_symbol: string | null
    }>

    return rows.map((r) => ({
      contract: r.contract,
      tokenCount: Number(r.token_count),
      collectionCreator: r.collection_creator,
      collectionKind: r.collection_kind,
      collectionName: r.collection_name,
      collectionSymbol: r.collection_symbol,
    }))
    // Bigger budget than the other indexer queries because this is the
    // headline read for the dependency report and under pool contention
    // (the orchestrator fires ~6 parallel Postgres calls + the seller-
    // listings adapters' own lazy reads against a max:2 pool) cold
    // queries can queue for >2s before they ever start running.
  }, 4_000)
}

// ─── Catalog ─────────────────────────────────────────────────────────────
//
// Replaces the per-render `viem.multicall` against the Catalog
// contract in `apps/web/src/lib/catalog.ts`. The three reads
// (contracts, tokens, ranges) are point lookups against the per-artist
// composite index on the catalog_* tables, so each query is cheap and
// the three run in parallel.
//
// Returns null when the indexer is disabled / unavailable / slow so the
// caller can fall through to the RPC path. An indexer that's healthy
// but legitimately has no entries for the artist returns an empty
// `Catalog` shape — same semantics as the on-chain getContracts() etc.
// returning empty arrays.
//
// Caveat: Ponder's chain-wide pollingInterval is 300s on mainnet (see
// ponder/ponder.config.ts). A write that confirms now may take up to
// 5 minutes before its event lands in these tables. The
// `useCatalogWrite` hook busts the page caches on tx success — that
// part still works — but the next render against this read can still
// see stale rows during the polling window. If the post-write UX
// becomes a problem, the cheapest fix is to reduce pollingInterval
// (cost rises ~5×) rather than adding a write-time RPC fallback here.

export type IndexerCatalog = {
  contracts: string[]
  tokens: Array<{ contractAddress: string; tokenId: string }>
  tokenRanges: Array<{
    contractAddress: string
    startTokenId: string
    endTokenId: string
  }>
}

export async function getCatalogFromIndexer(
  artistAddress: string,
): Promise<IndexerCatalog | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const artist = artistAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const [contractRows, tokenRows, rangeRows] = await Promise.all([
      db.unsafe(
        `SELECT contract_address
           FROM ${schema}.catalog_contracts
          WHERE artist = $1
          ORDER BY block_number ASC`,
        [artist],
      ) as Promise<Array<{ contract_address: string }>>,
      db.unsafe(
        `SELECT contract_address, token_id::text AS token_id
           FROM ${schema}.catalog_tokens
          WHERE artist = $1
          ORDER BY block_number ASC`,
        [artist],
      ) as Promise<
        Array<{ contract_address: string; token_id: string }>
      >,
      db.unsafe(
        `SELECT contract_address,
                start_token_id::text AS start_token_id,
                end_token_id::text   AS end_token_id
           FROM ${schema}.catalog_ranges
          WHERE artist = $1
          ORDER BY block_number ASC`,
        [artist],
      ) as Promise<
        Array<{
          contract_address: string
          start_token_id: string
          end_token_id: string
        }>
      >,
    ])

    return {
      contracts: contractRows.map((r) => r.contract_address),
      tokens: tokenRows.map((r) => ({
        contractAddress: r.contract_address,
        tokenId: r.token_id,
      })),
      tokenRanges: rangeRows.map((r) => ({
        contractAddress: r.contract_address,
        startTokenId: r.start_token_id,
        endTokenId: r.end_token_id,
      })),
    }
  }, 2_000)
}

export async function getActiveAuctionCountFromIndexer(
  sellerAddress: string,
): Promise<number | null> {
  if (INDEXER_DISABLED || !sql) return null
  // Capture in a non-null local — closures don't narrow `sql`'s nullable
  // type through `withTimeout`'s callback boundary.
  const db = sql

  return withTimeout(async () => {
    // Lower-cased everywhere because Ponder normalizes addresses to
    // lowercase when writing event args (per viem's policy).
    const seller = sellerAddress.toLowerCase()
    // Ponder namespaces its tables under a configurable schema (set via the
    // DATABASE_SCHEMA env var on the indexer service — currently `ponder`).
    // Default to `ponder` here so the web app and the indexer agree on the
    // location without an extra coordination step. Override with
    // INDEXER_SCHEMA if the indexer's schema name ever changes.
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    // Schema name comes from a controlled env var and is sanitized above
    // (postgres.js can't parameterize identifiers, only values), so the
    // unsafe-template usage is fine here.
    const rows = (await db.unsafe(
      `SELECT COUNT(*)::text AS count
       FROM ${schema}.pnd_auctions
       WHERE seller = $1 AND status = 'active'`,
      [seller],
    )) as Array<{ count: string }>

    return Number(rows[0]?.count ?? 0)
  }, 2_000)
}
