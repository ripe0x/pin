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
            NULL::text AS tx_hash
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
            NULL::text
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
            NULL::text
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
            NULL::text
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
            'auction.firstBid'::text,
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
          ${where("pb.first_bid = TRUE", "pb.block_time")}
          ORDER BY pb.block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'auction.firstBid'::text,
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
          ${where("sub.rn = 1", "sub.block_time")}
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
  }, 3_000)
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
  })
}
