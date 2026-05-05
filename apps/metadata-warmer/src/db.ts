import postgres from "postgres"

/**
 * Postgres client tuned for a long-lived sidecar.
 *
 * Unlike the web app's `apps/web/src/lib/db.ts` (max: 2 per Netlify
 * sandbox to avoid `too many clients`), this is a single process so we
 * can keep a slightly larger pool open. Workload is sequential batches
 * with one concurrent query each — `max: 4` covers the read+write cycle
 * plus the occasional healthcheck without contention.
 *
 * `INDEXER_SCHEMA` is the Postgres schema Ponder writes its tables into;
 * defaults to `ponder`, matching `apps/web/src/lib/indexer-queries.ts`.
 */

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.error("[metadata-warmer] DATABASE_URL is required")
  process.exit(1)
}

export const sql = postgres(DATABASE_URL, {
  max: 4,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
})

export const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
  /[^a-zA-Z0-9_]/g,
  "",
)

export type Candidate = { contract: string; tokenId: string }

/**
 * Find (contract, tokenId) pairs that need metadata resolution. Two
 * sources of candidates:
 *
 *   1. Refs in the Ponder source tables (`pnd_auctions`, `fnd_auctions`,
 *      `fnd_artist_tokens`, `fnd_buy_nows`, `fnd_sales`) that have no
 *      row in `token_metadata` yet. This is the steady-state work — a
 *      new auction or mint flows in, this query picks it up the next
 *      tick.
 *
 *   2. Previously-failed rows: ones with all metadata columns NULL
 *      (the "tried, returned nothing" sentinel) older than the retry
 *      horizon. IPFS pinning sometimes recovers later, so a periodic
 *      retry is worth the small upstream cost.
 *
 * The upsert in `writeTokenMetadata` advances `fetched_at = NOW()` on
 * every write, which naturally moves a re-attempted row out of the
 * retry pool for another `RETRY_AFTER` interval.
 */
export async function findCandidates(
  limit: number,
  retryAfter: string,
): Promise<Candidate[]> {
  const rows = await sql.unsafe(
    `WITH all_refs AS (
       SELECT lower(token_contract) AS contract, token_id::text AS token_id
         FROM ${INDEXER_SCHEMA}.pnd_auctions
       UNION
       SELECT lower(nft_contract), token_id::text
         FROM ${INDEXER_SCHEMA}.fnd_auctions
       UNION
       SELECT lower(contract), token_id::text
         FROM ${INDEXER_SCHEMA}.fnd_artist_tokens
       UNION
       SELECT lower(nft_contract), token_id::text
         FROM ${INDEXER_SCHEMA}.fnd_buy_nows
       UNION
       SELECT lower(nft_contract), token_id::text
         FROM ${INDEXER_SCHEMA}.fnd_sales
     ),
     candidates AS (
       SELECT r.contract, r.token_id
         FROM all_refs r
         LEFT JOIN public.token_metadata tm
           ON tm.contract = r.contract AND tm.token_id = r.token_id
         WHERE tm.contract IS NULL
       UNION
       SELECT r.contract, r.token_id
         FROM all_refs r
         JOIN public.token_metadata tm
           ON tm.contract = r.contract AND tm.token_id = r.token_id
         WHERE tm.name IS NULL
           AND tm.description IS NULL
           AND tm.image_url IS NULL
           AND tm.fetched_at < NOW() - $1::interval
     )
     SELECT contract, token_id FROM candidates LIMIT $2`,
    [retryAfter, limit],
  )
  return (rows as unknown as Array<{ contract: string; token_id: string }>).map(
    (r) => ({
      contract: r.contract,
      tokenId: r.token_id,
    }),
  )
}

export type WriteInput = {
  name?: string | null
  description?: string | null
  imageUrl?: string | null
  rawUri?: string | null
}

/**
 * Upsert a `token_metadata` row. Mirrors `writeTokenMetadata` in
 * `apps/web/src/lib/token-metadata-store.ts` — same row contract, same
 * conflict behavior. A row with all metadata fields NULL is the
 * "resolved-empty" sentinel that prevents the lazy web-app path from
 * re-fetching.
 */
export async function writeTokenMetadata(
  contract: string,
  tokenId: string,
  input: WriteInput,
): Promise<void> {
  await sql`
    INSERT INTO token_metadata (contract, token_id, name, description, image_url, raw_uri, fetched_at)
    VALUES (
      ${contract.toLowerCase()},
      ${tokenId},
      ${input.name ?? null},
      ${input.description ?? null},
      ${input.imageUrl ?? null},
      ${input.rawUri ?? null},
      NOW()
    )
    ON CONFLICT (contract, token_id) DO UPDATE
      SET name = EXCLUDED.name,
          description = EXCLUDED.description,
          image_url = EXCLUDED.image_url,
          raw_uri = EXCLUDED.raw_uri,
          fetched_at = EXCLUDED.fetched_at
  `
}
