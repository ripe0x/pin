/**
 * Worker startup checks against the Ponder schema it is configured to
 * read (INDEXER_SCHEMA). Both are NON-FATAL: they log loudly and the
 * worker starts regardless, because refusing to start would stop every
 * scanner, which is worse than scanning with a stale gate.
 *
 * 1. known_artists schema sync (#295, audit C2). The view is the spend
 *    ceiling every scanner joins on, and it bakes in a Ponder schema
 *    name. Migration 011 pinned it to whatever schema existed when it
 *    ran; migration 028 added `pnd_known_artists_schema()` (what the view
 *    reads now) and `pnd_rebuild_known_artists(schema)`. If the two
 *    disagree, rebuild against INDEXER_SCHEMA, so a cutover only has to
 *    flip the env var and redeploy the worker.
 *
 * 2. Freshness (audit H7). Mirrors scripts/check-indexer-schema.mjs and
 *    apps/web/src/lib/indexer-health.ts: decode the newest
 *    `_ponder_checkpoint` (falling back to auction activity) and warn if
 *    the configured schema exists but hasn't been written for N hours,
 *    i.e. the worker is pointed at a frozen schema.
 *
 * Takes the postgres client as an argument (no db.ts import) so the pure
 * pieces are unit-testable without DATABASE_URL.
 */

type Sql = {
  unsafe: (query: string, params?: string[]) => PromiseLike<unknown>
}

const DEFAULT_STALE_HOURS = 6

export function knownArtistsNeedsRebuild(
  current: string | null,
  target: string,
): boolean {
  return current !== target
}

export type FreshnessVerdict =
  | { status: "fresh"; ageSeconds: number }
  | { status: "stale"; ageSeconds: number }
  | { status: "unknown" }

export function judgeFreshness(
  latestBlockTs: number | null,
  nowSec: number,
  thresholdSec: number,
): FreshnessVerdict {
  if (latestBlockTs === null || !Number.isFinite(latestBlockTs) || latestBlockTs <= 0) {
    return { status: "unknown" }
  }
  const ageSeconds = Math.max(0, Math.floor(nowSec - latestBlockTs))
  return ageSeconds > thresholdSec
    ? { status: "stale", ageSeconds }
    : { status: "fresh", ageSeconds }
}

export function staleThresholdSec(env: string | undefined): number {
  const hours = Number(env)
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_STALE_HOURS) * 3600
}

/** Returns what the view reads after the check, or null if unknown. */
export async function syncKnownArtistsSchema(
  sql: Sql,
  schema: string,
): Promise<string | null> {
  let current: string | null
  try {
    const rows = (await sql.unsafe(
      "SELECT public.pnd_known_artists_schema() AS schema",
    )) as Array<{ schema: string | null }>
    current = rows[0]?.schema ?? null
  } catch (err) {
    console.error(
      "[worker.startup] !!! could not read known_artists' schema " +
      "(is migration 028 applied? run `pnpm db:migrate`). " +
      `The spend ceiling may be reading a stale Ponder schema instead of ${schema}:`,
      err,
    )
    return null
  }

  if (!knownArtistsNeedsRebuild(current, schema)) {
    console.log(`[worker.startup] known_artists reads ${schema} (matches INDEXER_SCHEMA)`)
    return current
  }

  console.warn(
    `[worker.startup] known_artists reads ${current ?? "(no Ponder schema: bootstrap view)"} ` +
    `but INDEXER_SCHEMA=${schema}; rebuilding`,
  )
  try {
    await sql.unsafe("SELECT public.pnd_rebuild_known_artists($1)", [schema])
    const rows = (await sql.unsafe(
      "SELECT count(*)::int AS n FROM public.known_artists",
    )) as Array<{ n: number }>
    console.log(
      `[worker.startup] known_artists rebuilt against ${schema}: ${rows[0]?.n ?? "?"} addresses`,
    )
    return schema
  } catch (err) {
    console.error(
      `[worker.startup] !!! known_artists rebuild against ${schema} FAILED; ` +
      `the view still reads ${current ?? "(bootstrap)"}. Artists who joined after that ` +
      "schema froze are outside the spend ceiling and will NOT be scanned:",
      err,
    )
    return current
  }
}

export async function checkIndexerFreshness(
  sql: Sql,
  schema: string,
  thresholdSec = staleThresholdSec(process.env.INDEXER_STALE_HOURS),
): Promise<FreshnessVerdict> {
  // `schema` is already sanitized to [A-Za-z0-9_] (indexer-schema.ts),
  // so inlining it is safe; this is the same query the build guard runs.
  let latestTs: number | null = null
  try {
    const rows = (await sql.unsafe(
      `SELECT substring(latest_checkpoint, 1, 10)::bigint AS block_ts
       FROM ${schema}._ponder_checkpoint
       ORDER BY latest_checkpoint DESC
       LIMIT 1`,
    )) as Array<{ block_ts: string | number | null }>
    latestTs = rows[0]?.block_ts != null ? Number(rows[0].block_ts) : null
  } catch {
    latestTs = null
  }
  if (latestTs === null) {
    try {
      const rows = (await sql.unsafe(
        `SELECT GREATEST(
           (SELECT COALESCE(MAX(created_at_time), 0) FROM ${schema}.pnd_auctions),
           (SELECT COALESCE(MAX(block_time), 0) FROM ${schema}.pnd_bids)
         )::bigint AS block_ts`,
      )) as Array<{ block_ts: string | number | null }>
      const ts = rows[0]?.block_ts != null ? Number(rows[0].block_ts) : 0
      latestTs = ts > 0 ? ts : null
    } catch {
      latestTs = null
    }
  }

  const verdict = judgeFreshness(latestTs, Date.now() / 1000, thresholdSec)
  if (verdict.status === "stale") {
    console.error(
      `[worker.startup] !!! INDEXER_SCHEMA=${schema} is STALE: last written ` +
      `${new Date(latestTs! * 1000).toISOString()} (${Math.floor(verdict.ageSeconds / 3600)}h ago, ` +
      `threshold ${thresholdSec / 3600}h). Every Ponder-gated task is reading frozen data; ` +
      "check INDEXER_SCHEMA on this service against the live indexer.",
    )
  } else if (verdict.status === "unknown") {
    console.error(
      `[worker.startup] !!! INDEXER_SCHEMA=${schema}: no readable checkpoint or auction ` +
      "activity (schema missing, or Ponder has not written yet).",
    )
  } else {
    console.log(
      `[worker.startup] INDEXER_SCHEMA=${schema} fresh (last written ${Math.floor(verdict.ageSeconds / 60)}m ago)`,
    )
  }
  return verdict
}

/** Both checks, each isolated; never throws. */
export async function runStartupChecks(sql: Sql, schema: string): Promise<void> {
  await checkIndexerFreshness(sql, schema).catch((err) => {
    console.error("[worker.startup] freshness check crashed:", err)
  })
  await syncKnownArtistsSchema(sql, schema).catch((err) => {
    console.error("[worker.startup] known_artists sync crashed:", err)
  })
}
