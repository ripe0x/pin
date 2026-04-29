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
