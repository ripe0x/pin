import { sql } from "./db"

/**
 * Postgres-backed shared cache (L2). Sits below `unstable_cache` (L1, in-
 * process) and above the upstream fetcher (RPC / Alchemy NFT API).
 *
 * Why this layer exists: `unstable_cache` is per-instance. Netlify spins up
 * multiple Function sandboxes; each gets a cold cache. Without an L2, a
 * traffic burst across sandboxes pays the upstream cost N times even though
 * the same key is being fetched. Postgres is one box every sandbox shares,
 * so identical keys collapse to one upstream fetch per TTL window.
 *
 * **Kill switch.** When `DATABASE_URL` is unset (Postgres not provisioned
 * yet, or explicitly disabled), `sql` is null and `pgCache` short-circuits
 * to the fetcher. Behavior is identical to running without this layer at
 * all — same as the existing `unstable_cache`-only path. Drop the env var
 * to disable L2 instantly.
 *
 * Bigint handling: callers serialize bigints to strings before caching and
 * hydrate on the way out. Same pattern the existing `unstable_cache`
 * wrappers use, since both layers rely on JSON serialization.
 */

export async function pgCache<T>(
  key: string,
  ttlSec: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (!sql) return fetcher()

  // Read path: serve unexpired entries directly. We don't lock or
  // single-flight here — if two sandboxes miss simultaneously, both fetch
  // and one's INSERT is overwritten by the other's. The total upstream
  // cost is at most 2× per TTL boundary, which is fine.
  try {
    const rows = await sql<Array<{ value: T }>>`
      SELECT value
      FROM cache_entries
      WHERE key = ${key} AND expires_at > NOW()
      LIMIT 1
    `
    if (rows.length > 0) return rows[0].value
  } catch {
    // DB transient failure — fall through to the fetcher. The L1 layer
    // above will at least catch this within the current sandbox.
    return fetcher()
  }

  const value = await fetcher()

  // Write-through. ON CONFLICT keeps the row fresh on every miss without
  // requiring an upsert dance from callers. Fire-and-forget the write so
  // a slow DB doesn't add to render latency — if the write fails, the
  // next visit just re-fetches.
  //
  // We pre-stringify rather than relying on postgres.js's JSON inference
  // because the helper accepts arbitrary `T` (including primitives like
  // `string | null` for ENS) which the library's typed `json()` rejects.
  // The cast back to JSONB happens via the `::jsonb` annotation.
  const serialized = JSON.stringify(value)
  void sql`
    INSERT INTO cache_entries (key, value, expires_at)
    VALUES (${key}, ${serialized}::jsonb, NOW() + (${ttlSec} || ' seconds')::interval)
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
  `.catch(() => {})

  return value
}

/**
 * Invalidate cached entries by key prefix. Called by:
 *   - `/api/auction/revalidate` after a bid / settle / cancel / update tx
 *     confirms (prefix = `auction:<contract>:<tokenId>`).
 *   - `/api/revalidate` when the artist gallery cache is manually flushed
 *     (prefixes = `artist-tokens:`, `artist-enriched:`, `ens:`, etc.).
 *
 * Pattern uses `LIKE` with an anchored prefix; for tag-style invalidation
 * across many keys this is fine at our scale (the cache table will be in
 * the low thousands of rows). If row counts grow much larger we'd add a
 * `tag` column with a B-tree index.
 */
export async function pgCacheInvalidate(keyPrefix: string): Promise<void> {
  if (!sql) return
  try {
    await sql`DELETE FROM cache_entries WHERE key LIKE ${keyPrefix + "%"}`
  } catch {
    // Non-fatal — the row will expire on its TTL anyway.
  }
}

/**
 * Garbage-collect rows whose TTL elapsed more than `graceDays` ago.
 * Called by a scheduled Netlify function (or run manually). Stale entries
 * are also overwritten on the next miss for their key, so this is purely
 * for storage hygiene — runs daily, not hot path.
 */
export async function pgCacheCleanup(graceDays = 1): Promise<number> {
  if (!sql) return 0
  try {
    const result = await sql`
      DELETE FROM cache_entries
      WHERE expires_at < NOW() - (${graceDays} || ' days')::interval
    `
    return result.count
  } catch {
    return 0
  }
}
