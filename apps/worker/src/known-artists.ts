import { sql } from "./db.ts"
import { INDEXER_SCHEMA } from "./indexer-schema.ts"

/**
 * known_artists is the worker's spend ceiling (membership rules in
 * db/migrations/011_known_artists_view.sql). A view binds to the schema
 * it was created against, so a migration alone froze it on ponder_v2 and
 * new artists stopped joining after the v3/v4 cutovers. Rebuilding it from
 * INDEXER_SCHEMA at every boot makes it follow each cutover, which already
 * redeploys the worker with the new INDEXER_SCHEMA.
 */
export function knownArtistsViewSql(schema: string): string {
  const s = schema
  return `CREATE OR REPLACE VIEW public.known_artists AS
SELECT DISTINCT lower(owner) AS address FROM ${s}.pnd_houses
UNION SELECT DISTINCT lower(creator) FROM ${s}.fnd_collections
UNION SELECT DISTINCT lower(address) FROM public.artist_seeds
UNION SELECT DISTINCT lower(address) FROM ${s}.mint_creators
UNION SELECT DISTINCT lower(t.sender) FROM ${s}.tl_creators t
  WHERE t.c_type LIKE 'ERC721%' AND EXISTS (
    SELECT 1 FROM ${s}.pnd_houses WHERE lower(owner) = lower(t.sender)
    UNION SELECT 1 FROM ${s}.fnd_collections WHERE lower(creator) = lower(t.sender)
    UNION SELECT 1 FROM ${s}.mint_creators WHERE lower(address) = lower(t.sender)
    UNION SELECT 1 FROM ${s}.catalog_contracts WHERE lower(artist) = lower(t.sender)
    UNION SELECT 1 FROM ${s}.catalog_tokens WHERE lower(artist) = lower(t.sender)
    UNION SELECT 1 FROM ${s}.catalog_ranges WHERE lower(artist) = lower(t.sender)
    UNION SELECT 1 FROM public.artist_seeds WHERE lower(address) = lower(t.sender))
UNION SELECT DISTINCT lower(artist) FROM ${s}.catalog_contracts
UNION SELECT DISTINCT lower(artist) FROM ${s}.catalog_tokens
UNION SELECT DISTINCT lower(artist) FROM ${s}.catalog_ranges`
}

/** Failure keeps the previous view, so a half-built schema never empties the gate. */
export async function rebuildKnownArtistsView(): Promise<void> {
  try {
    await sql.unsafe(knownArtistsViewSql(INDEXER_SCHEMA))
    const [row] = await sql`SELECT count(*)::int AS n FROM known_artists`
    console.log(`[worker] known_artists rebuilt on ${INDEXER_SCHEMA}: ${row.n} addresses`)
  } catch (err) {
    console.error(`[worker] known_artists rebuild on ${INDEXER_SCHEMA} failed, keeping old view:`, err)
  }
}
