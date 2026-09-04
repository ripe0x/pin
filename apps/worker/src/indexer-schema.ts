/**
 * Single source of truth for the Ponder schema name every worker task
 * reads from. This default MUST track whichever schema Ponder is actively
 * writing in production, the same contract as
 * apps/web/src/lib/indexer-schema.ts. A stale default here reads a dead,
 * frozen schema with no error. `INDEXER_SCHEMA` overrides this per deploy
 * context; verify the production value matches the live schema before
 * relying on the default.
 */
export const DEFAULT_INDEXER_SCHEMA = "ponder_v3"

/**
 * Allowlist sanitizer: keeps only [A-Za-z0-9_], so the result is always a
 * plain identifier and safe to inline into raw SQL. Anything else in the
 * env value is dropped rather than escaped, so a malformed value yields a
 * schema name that does not exist and every query fails loudly.
 */
export function sanitizeSchemaName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "")
}

export const INDEXER_SCHEMA = sanitizeSchemaName(
  process.env.INDEXER_SCHEMA ?? DEFAULT_INDEXER_SCHEMA,
)
