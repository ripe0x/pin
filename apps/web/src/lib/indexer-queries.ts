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
    const rows = await db<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count
      FROM pnd_auctions
      WHERE seller = ${seller}
        AND status = 'active'
    `
    return Number(rows[0]?.count ?? 0)
  })
}
