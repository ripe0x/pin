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
 * **Null envelope.** The `cache_entries.value` column is JSONB NOT NULL, but
 * fetchers legitimately return `null` (no ENS for an address, no last sale
 * for a token, no on-chain metadata). Writing raw `null` violates the
 * constraint and silently fails — meaning nulls would never cache, and the
 * upstream fetcher would re-run on every request. We wrap every value as
 * `{v: value}` so `null` becomes `{v: null}` (a non-null JSONB object). Read
 * path unwraps; legacy raw values written before this change pass through
 * unchanged until they expire.
 *
 * Bigint handling: callers serialize bigints to strings before caching and
 * hydrate on the way out. Same pattern the existing `unstable_cache`
 * wrappers use, since both layers rely on JSON serialization.
 */

type Envelope<T> = { v: T }

function isEnvelope<T>(v: unknown): v is Envelope<T> {
  return (
    typeof v === "object" &&
    v !== null &&
    "v" in (v as Record<string, unknown>) &&
    Object.keys(v as Record<string, unknown>).length === 1
  )
}

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
    const rows = await sql<Array<{ value: unknown }>>`
      SELECT value
      FROM cache_entries
      WHERE key = ${key} AND expires_at > NOW()
      LIMIT 1
    `
    if (rows.length > 0) {
      const raw = rows[0].value
      // New format: {v: actual}. Old format: actual itself. Distinguish by
      // shape — a single-key object with key "v" is the envelope.
      return isEnvelope<T>(raw) ? raw.v : (raw as T)
    }
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
  // postgres.js auto-serializes objects to JSONB when bound to a JSONB
  // column. We use `sql.json(...)` to be explicit and to handle the cases
  // where T can be a primitive (string | null for ENS) — the helper
  // accepts any JSON-shaped value. **Critical: do NOT pre-stringify**.
  // An earlier version called `JSON.stringify(value)` and bound the
  // resulting string with a `::jsonb` cast; postgres.js then JSON-encoded
  // the string AGAIN, producing a JSONB-string-of-JSON instead of a
  // JSONB-object. Reads returned strings, callers did `.name` on them and
  // got `undefined`, and every cached metadata fell back to placeholders.
  const envelope: Envelope<T> = { v: value }
  void sql`
    INSERT INTO cache_entries (key, value, expires_at)
    VALUES (${key}, ${sql.json(envelope as never)}, NOW() + (${ttlSec} || ' seconds')::interval)
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
 * Cheap point lookup: is this key currently cached (and unexpired)? Used by
 * server components to decide between "first-time-here" and "still working"
 * loading copy without paying for the upstream fetch yet.
 *
 * Returns false on DB unavailable / disabled — the safe default is to
 * assume the cache is cold and show the more informative message.
 */
export async function pgCacheHas(key: string): Promise<boolean> {
  if (!sql) return false
  try {
    const r = await sql<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM cache_entries
      WHERE key = ${key} AND expires_at > NOW()
      LIMIT 1
    `
    return r.length > 0
  } catch {
    return false
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
