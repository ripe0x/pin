import "server-only"
import { sql } from "./db"
import { INDEXER_SCHEMA } from "./indexer-schema"
import { withTimeout } from "./indexer-queries"
import { buildAttributionRoster, type AttributionRoster, type ListedCreatorRow } from "./attribution"

const INDEXER_DISABLED = process.env.INDEXER_DISABLED === "1"

const NONE: AttributionRoster = { basis: "none", entries: [] }

// `collection_creators` arrives with the ponder_v5 replay (indexer PR #370);
// production reads ponder_v4 until the cutover, and web and indexer deploy
// independently. Probe once per process, sticky once true, the same pattern
// as surfaceTablesExist in indexer-queries.ts. Absent: a v1 collection has
// no roster (lib/attribution.ts). A probe that errors is null, not false;
// the caller hides the roster and the next call probes again.
const tablesSeen = new Set<string>()
async function tableExists(db: NonNullable<typeof sql>, schema: string, table: string): Promise<boolean | null> {
  if (tablesSeen.has(table)) return true
  try {
    const rows = (await db.unsafe(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${schema}.${table}`])) as Array<{
      ok: boolean
    }>
    if (rows[0]?.ok) tablesSeen.add(table)
    return tablesSeen.has(table)
  } catch {
    return null
  }
}

/**
 * A collection's attribution roster from Postgres alone (zero chain reads;
 * the live owner is the one getCollection already read). Rules in
 * lib/attribution.ts:
 *
 * - primitive v2: only the owner's own Catalog claim (`catalog_contracts`)
 *   is credited. Once renounced (live owner zero) the indexed
 *   `collections.owner` stands in as the launch owner when it is still
 *   nonzero.
 * - v1: the owner's listing (`collection_creators`, listed = true)
 *   intersected with Catalog claims. Without that table: no roster.
 *
 * `basis: "none"` with no entries when the indexer is unavailable, slow or
 * disabled, a needed table is missing, or a probe errors.
 */
export async function getAttributionRoster(
  collection: string,
  c: { primitiveV2: boolean; owner: string },
): Promise<AttributionRoster> {
  if (INDEXER_DISABLED || !sql) return NONE
  const db = sql
  const schema = INDEXER_SCHEMA
  const [hasCatalog, hasCreators] = await Promise.all([
    tableExists(db, schema, "catalog_contracts"),
    c.primitiveV2 ? Promise.resolve(false) : tableExists(db, schema, "collection_creators"),
  ])
  if (!hasCatalog || hasCreators === null) return NONE
  // v1 without the owner's listing: nothing creditable (no Catalog-only
  // fallback), so skip the reads entirely.
  if (!c.primitiveV2 && !hasCreators) return NONE
  const addr = collection.toLowerCase()
  const roster = await withTimeout(async () => {
    const claimsQuery = db.unsafe(
      `SELECT artist FROM ${schema}.catalog_contracts
       WHERE contract_address = $1
       ORDER BY block_number ASC, artist ASC`,
      [addr],
    ) as Promise<Array<{ artist: string }>>
    if (c.primitiveV2) {
      const [claimRows, ownerRows] = await Promise.all([
        claimsQuery,
        db.unsafe(`SELECT owner FROM ${schema}.collections WHERE collection = $1 LIMIT 1`, [addr]) as Promise<
          Array<{ owner: string }>
        >,
      ])
      return buildAttributionRoster({
        kind: "v2",
        claims: claimRows.map((r) => r.artist),
        owner: c.owner,
        launchOwner: ownerRows[0]?.owner ?? null,
      })
    }
    const [claimRows, listedRows] = await Promise.all([
      claimsQuery,
      db.unsafe(
        `SELECT creator, listed FROM ${schema}.collection_creators
         WHERE collection = $1
         ORDER BY first_listed_at_block ASC, creator ASC`,
        [addr],
      ) as Promise<ListedCreatorRow[]>,
    ])
    return buildAttributionRoster({ kind: "v1", listed: listedRows, claims: claimRows.map((r) => r.artist) })
  }, 1_000)
  return roster ?? NONE
}
