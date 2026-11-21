// No "server-only" guard: this module only builds SQL strings and dedupes
// plain rows, so the plain-Node test runner can import it.

/**
 * One artist's token refs, from every per-artist source, with exactly one
 * row per (contract, token_id).
 *
 * The sources overlap. The worker's scan-fnd-shared writes Foundation
 * shared 1/1s to `public.artist_tokens` (platform 'fnd-shared', from the
 * FND deploy block), and Ponder writes the same mints to
 * `fnd_artist_tokens` from its FND start block (24,973,294). A plain
 * `UNION ALL` (what reads.ts and onchain-discovery.ts used) listed every
 * FND shared mint after that block twice, which inflated gallery totals
 * and broke OFFSET pagination (#295, audit H4).
 *
 * Precedence when a token appears in more than one source, in
 * `ARTIST_TOKEN_SOURCES` order: the worker's `artist_tokens` row wins
 * (it is the row the worker enriches, e.g. `mint_time`, and its platform
 * label is the one the worker assigned), then Ponder's FND rows, then
 * Ponder's SR V2 rows. Within a source the (contract, token_id) key is
 * already unique. Remaining ties break on the earliest mint position, so
 * the choice never depends on scan order.
 */
export const ARTIST_TOKEN_SOURCES = [
  "artist_tokens",
  "fnd_artist_tokens",
  "srv2_artist_tokens",
] as const

export type ArtistTokenSource = (typeof ARTIST_TOKEN_SOURCES)[number]

const rank = (s: ArtistTokenSource) => ARTIST_TOKEN_SOURCES.indexOf(s)

/**
 * Every source row, NOT deduped, with a `src_rank` column (lower wins).
 * Columns: contract (lowercase), token_id (text), platform, mint_block,
 * mint_log_index, src_rank. `$1` is the lowercase artist address.
 *
 * `schema` must already be sanitized (lib/indexer-schema.ts's
 * INDEXER_SCHEMA is), since it is inlined.
 */
export function artistTokenSourcesSql(schema: string): string {
  return `SELECT lower(contract) AS contract, token_id::text AS token_id, platform,
              mint_block, mint_log_index, ${rank("artist_tokens")} AS src_rank
       FROM artist_tokens WHERE artist = $1
       UNION ALL
       SELECT lower(contract), token_id::text, 'fnd-shared'::text,
              block_number, log_index, ${rank("fnd_artist_tokens")}
       FROM ${schema}.fnd_artist_tokens WHERE lower(creator) = $1
       UNION ALL
       SELECT lower(contract), token_id::text, 'srv2-shared'::text,
              block_number, log_index, ${rank("srv2_artist_tokens")}
       FROM ${schema}.srv2_artist_tokens WHERE lower(creator) = $1`
}

/**
 * The deduped refs: one row per (contract, token_id), chosen by the
 * precedence above. Columns: contract, token_id, platform, mint_block,
 * mint_log_index. Use it as a CTE body or subquery; counts and
 * LIMIT/OFFSET over it are over distinct tokens.
 */
export function artistTokenRefsSql(schema: string): string {
  return `SELECT DISTINCT ON (s.contract, s.token_id)
              s.contract, s.token_id, s.platform, s.mint_block, s.mint_log_index
       FROM (${artistTokenSourcesSql(schema)}) s
       ORDER BY s.contract, s.token_id, s.src_rank, s.mint_block, s.mint_log_index`
}

export type ArtistTokenSourceRow = {
  contract: string
  token_id: string
  platform: string
  mint_block: string | number | bigint
  mint_log_index: number | string
  src_rank: number | string
}

/**
 * The same rule as `artistTokenRefsSql`, applied in JS to rows from
 * `artistTokenSourcesSql` (for callers that already hold every row).
 * Keeps first-seen order of the surviving rows' keys.
 */
export function dedupeArtistTokenRefs<T extends ArtistTokenSourceRow>(rows: T[]): T[] {
  const best = new Map<string, T>()
  for (const r of rows) {
    const key = `${r.contract.toLowerCase()}:${r.token_id}`
    const cur = best.get(key)
    if (!cur || compareRefs(r, cur) < 0) best.set(key, r)
  }
  return Array.from(best.values())
}

function compareRefs(a: ArtistTokenSourceRow, b: ArtistTokenSourceRow): number {
  const byRank = Number(a.src_rank) - Number(b.src_rank)
  if (byRank !== 0) return byRank
  const ab = BigInt(a.mint_block)
  const bb = BigInt(b.mint_block)
  if (ab !== bb) return ab < bb ? -1 : 1
  return Number(a.mint_log_index) - Number(b.mint_log_index)
}
