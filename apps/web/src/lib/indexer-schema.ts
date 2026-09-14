// No "server-only" guard here (unlike every module that imports this one):
// this file only computes a string from an env var, it does no DB/chain
// access, and it needs to be importable by the plain-Node test runner.

/**
 * Single source of truth for the Ponder schema name every indexer query
 * reads from. This default MUST track whichever schema Ponder is actively
 * writing in production — a stale default here reads a dead, frozen
 * schema with no error (this is exactly how production silently served
 * `ponder_v1`, frozen since 2026-07-15, for weeks after the live indexer
 * moved to `ponder_v2`). Netlify's `INDEXER_SCHEMA` env var overrides this
 * per deploy context; verify the production context's value matches the
 * live schema before relying on the default.
 */
export const DEFAULT_INDEXER_SCHEMA = "ponder_v2"

/** Strip everything but identifier characters so this is safe to inline into raw SQL. */
export function sanitizeSchemaName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "")
}

export const INDEXER_SCHEMA = sanitizeSchemaName(
  process.env.INDEXER_SCHEMA ?? DEFAULT_INDEXER_SCHEMA,
)
