// No "server-only" guard: SQL builders + a pure ranker, so the plain-Node
// test runner and the PGlite check can import it.

/**
 * Normalized sale state for an artist's works (#297 part 2): is a token
 * in a live auction, listed at a fixed price, or neither, from Postgres
 * only (no request-time chain reads, no new scanning).
 *
 * Sources, all optional (each is existence-checked, see
 * loadAvailabilityTables):
 *
 *   rank 0  live auction
 *     <INDEXER_SCHEMA>.pnd_auctions     PND auction houses (Ponder)
 *     <INDEXER_SCHEMA>.fnd_auctions     Foundation reserve auctions (Ponder)
 *     public.srv2_active_auctions       SR V2 Bazaar (worker tracker)
 *     public.tl_active_auctions         TL listing types 1/2 (worker tracker)
 *   rank 1  listed / buy now
 *     <INDEXER_SCHEMA>.fnd_buy_nows     Foundation buy now (Ponder)
 *     public.tl_active_auctions         TL listing type 3 (BuyNow)
 *
 * "Live" means status 'active' and not past its end time (an ended but
 * unsettled auction is not available). A V2 PND listing past its
 * no-bid `listing_expiry` is not live either. The worker trackers are
 * only trusted while fresh: a row not re-observed within
 * TRACKER_FRESHNESS_MINUTES (6x the 5-minute scan cadence) is treated as
 * unknown, never as confidently live.
 *
 * Not used: `fnd_cancellable_listings` (a frozen candidate set that the
 * delist flow re-verifies on chain; it can't prove a listing is live).
 * Foundation buy-nows set before Ponder's FND start block are therefore
 * not ranked; the gallery's per-page buy-price read still shows them.
 */

export type GallerySort = "availability" | "newest"
export const DEFAULT_GALLERY_SORT: GallerySort = "availability"

export function parseGallerySort(raw: string | null | undefined): GallerySort {
  return raw === "newest" ? "newest" : DEFAULT_GALLERY_SORT
}

export const TRACKER_FRESHNESS_MINUTES = 30

/** Which optional sources exist on this database. */
export type AvailabilityTables = {
  pndAuctions: boolean
  /** pnd_auctions has V2's listing_expiry column. */
  pndListingExpiry: boolean
  fndAuctions: boolean
  fndBuyNows: boolean
  srv2: boolean
  tl: boolean
}

export const NO_AVAILABILITY_TABLES: AvailabilityTables = {
  pndAuctions: false,
  pndListingExpiry: false,
  fndAuctions: false,
  fndBuyNows: false,
  srv2: false,
  tl: false,
}

// Same character set as indexer-schema.ts's sanitizeSchemaName.
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertSchema(schema: string): void {
  if (!SCHEMA_RE.test(schema)) throw new Error(`unsafe schema name: ${schema}`)
}

export const AVAILABILITY_TABLES_SQL =
  `SELECT to_regclass($1) IS NOT NULL AS pnd_auctions,
          EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = $6 AND table_name = 'pnd_auctions'
                     AND column_name = 'listing_expiry') AS pnd_listing_expiry,
          to_regclass($2) IS NOT NULL AS fnd_auctions,
          to_regclass($3) IS NOT NULL AS fnd_buy_nows,
          to_regclass($4) IS NOT NULL AS srv2,
          to_regclass($5) IS NOT NULL AS tl`

export type AvailabilitySql = {
  unsafe: (query: string, params?: Array<string | number>) => PromiseLike<unknown>
}

const TABLES_TTL_MS = 10 * 60_000
const tablesCache = new Map<string, { at: number; tables: AvailabilityTables }>()

/**
 * Existence check for every optional source, cached per schema for 10
 * minutes. Tables appear (migrations, a schema cutover) far less often.
 */
export async function loadAvailabilityTables(
  sql: AvailabilitySql,
  schema: string,
  now = Date.now(),
): Promise<AvailabilityTables> {
  assertSchema(schema)
  const hit = tablesCache.get(schema)
  if (hit && now - hit.at < TABLES_TTL_MS) return hit.tables
  const rows = (await sql.unsafe(AVAILABILITY_TABLES_SQL, [
    `${schema}.pnd_auctions`,
    `${schema}.fnd_auctions`,
    `${schema}.fnd_buy_nows`,
    "public.srv2_active_auctions",
    "public.tl_active_auctions",
    schema,
  ])) as Array<Record<string, boolean>>
  const r = rows[0] ?? {}
  const tables: AvailabilityTables = {
    pndAuctions: !!r.pnd_auctions,
    pndListingExpiry: !!r.pnd_auctions && !!r.pnd_listing_expiry,
    fndAuctions: !!r.fnd_auctions,
    fndBuyNows: !!r.fnd_buy_nows,
    srv2: !!r.srv2,
    tl: !!r.tl,
  }
  tablesCache.set(schema, { at: now, tables })
  return tables
}

const NOW_EPOCH = "EXTRACT(EPOCH FROM NOW())::bigint"
const FRESH = `NOW() - interval '${TRACKER_FRESHNESS_MINUTES} minutes'`

/**
 * One row per (contract, token_id) of `refsRel` that is available:
 * columns contract, token_id, sale_rank (0 live auction, 1 listed),
 * source, ends_at (unix seconds, live timed auctions only). `refsRel`
 * names a relation (CTE) with lowercase `contract` and decimal-text
 * `token_id` columns. Ponder hex columns are stored lowercase and token
 * ids as numeric, so the joins hit the (contract, token_id) indexes.
 */
export function saleStateSql(
  schema: string,
  tables: AvailabilityTables,
  refsRel: string,
): string {
  assertSchema(schema)
  if (!SCHEMA_RE.test(refsRel)) throw new Error(`unsafe relation name: ${refsRel}`)
  const parts: string[] = []
  if (tables.pndAuctions) {
    const expiry = tables.pndListingExpiry
      ? ` AND NOT (a.end_time = 0 AND COALESCE(a.listing_expiry, 0) > 0
                   AND a.listing_expiry <= ${NOW_EPOCH})`
      : ""
    parts.push(
      `SELECT r.contract, r.token_id, 0 AS sale_rank, 'pnd'::text AS source,
              NULLIF(a.end_time, 0)::bigint AS ends_at
         FROM ${refsRel} r
         JOIN ${schema}.pnd_auctions a
           ON a.token_contract = r.contract AND a.token_id = r.token_id::numeric
        WHERE a.status = 'active'
          AND (a.end_time = 0 OR a.end_time > ${NOW_EPOCH})${expiry}`,
    )
  }
  if (tables.fndAuctions) {
    parts.push(
      `SELECT r.contract, r.token_id, 0, 'fnd-auction'::text,
              NULLIF(a.end_time, 0)::bigint
         FROM ${refsRel} r
         JOIN ${schema}.fnd_auctions a
           ON a.nft_contract = r.contract AND a.token_id = r.token_id::numeric
        WHERE a.status = 'active'
          AND (a.end_time = 0 OR a.end_time > ${NOW_EPOCH})`,
    )
  }
  if (tables.srv2) {
    parts.push(
      `SELECT r.contract, r.token_id, 0, 'srv2'::text,
              NULLIF(s.end_time, 0)::bigint
         FROM ${refsRel} r
         JOIN srv2_active_auctions s
           ON s.contract = r.contract AND s.token_id = r.token_id
        WHERE s.status = 'active' AND s.updated_at > ${FRESH}
          AND (s.end_time = 0 OR s.end_time > ${NOW_EPOCH})`,
    )
  }
  if (tables.tl) {
    parts.push(
      `SELECT r.contract, r.token_id,
              CASE WHEN t.listing_type = 3 THEN 1 ELSE 0 END,
              CASE WHEN t.listing_type = 3 THEN 'tl-buy-now' ELSE 'tl-auction' END::text,
              CASE WHEN t.listing_type = 3 THEN NULL ELSE NULLIF(t.end_time, 0) END::bigint
         FROM ${refsRel} r
         JOIN tl_active_auctions t
           ON t.contract = r.contract AND t.token_id = r.token_id
        WHERE t.status = 'active' AND t.updated_at > ${FRESH}
          AND t.listing_type IN (1, 2, 3)
          AND (t.listing_type = 3 OR t.end_time = 0 OR t.end_time > ${NOW_EPOCH})`,
    )
  }
  if (tables.fndBuyNows) {
    parts.push(
      `SELECT r.contract, r.token_id, 1, 'fnd-buy-now'::text, NULL::bigint
         FROM ${refsRel} r
         JOIN ${schema}.fnd_buy_nows b
           ON b.nft_contract = r.contract AND b.token_id = r.token_id::numeric
        WHERE b.status = 'active'`,
    )
  }
  if (parts.length === 0) {
    return `SELECT NULL::text AS contract, NULL::text AS token_id, NULL::int AS sale_rank,
                   NULL::text AS source, NULL::bigint AS ends_at
             WHERE false`
  }
  // A token in more than one source keeps its best (lowest) rank.
  return `SELECT DISTINCT ON (x.contract, x.token_id)
                 x.contract, x.token_id, x.sale_rank, x.source, x.ends_at
            FROM (${parts.join("\n UNION ALL \n")}) x
           ORDER BY x.contract, x.token_id, x.sale_rank, x.ends_at NULLS LAST`
}

/** Postgres text[] literal (quoted, escaped) for a `$n::text[]` param. */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`
}

/**
 * Sale state for an explicit key list: `$1` text[] of lowercase
 * contracts, `$2` text[] of token ids (pairwise; see pgTextArray).
 */
export function saleStateForKeysSql(schema: string, tables: AvailabilityTables): string {
  return `WITH sale_keys AS (
            SELECT DISTINCT contract, token_id
              FROM unnest($1::text[], $2::text[]) AS k(contract, token_id)
          )
          ${saleStateSql(schema, tables, "sale_keys")}`
}

/**
 * ORDER BY for a gallery over refs `r` LEFT JOINed to sale state `s`.
 * Availability: live auctions (ending soonest first, then reserve-only
 * ones), then listed, then everything else; newest mint first within a
 * tier. Newest: mint recency only. Both end on contract/token_id so
 * OFFSET pages never overlap or skip.
 */
export function galleryOrderBySql(sort: GallerySort, r = "r", s = "s"): string {
  const recency = `${r}.mint_block DESC, ${r}.mint_log_index DESC, ${r}.contract, ${r}.token_id`
  if (sort === "newest") return recency
  return `COALESCE(${s}.sale_rank, 2), ${s}.ends_at ASC NULLS LAST, ${recency}`
}

// ─── JS ranking (callers that already hold every ref) ────────────────────

export type SaleState = {
  rank: 0 | 1
  source: string
  /** Unix seconds; live timed auctions only. */
  endsAt: number | null
}

export type SaleStateRow = {
  contract: string
  token_id: string
  sale_rank: number | string
  source: string
  ends_at: number | string | null
}

export function saleKey(contract: string, tokenId: string): string {
  return `${contract.toLowerCase()}:${tokenId}`
}

export function saleStateMap(rows: SaleStateRow[]): Map<string, SaleState> {
  const out = new Map<string, SaleState>()
  for (const r of rows) {
    out.set(saleKey(r.contract, r.token_id), {
      rank: Number(r.sale_rank) === 0 ? 0 : 1,
      source: r.source,
      endsAt: r.ends_at == null ? null : Number(r.ends_at),
    })
  }
  return out
}

/**
 * Same order as galleryOrderBySql, for refs already in newest-first
 * order (discoverArtistTokenRefs): a stable sort by tier and end time
 * keeps mint recency within each tier. "newest" returns the input order.
 */
export function rankRefsByAvailability<T extends { contract: string; tokenId: string }>(
  refs: readonly T[],
  sale: ReadonlyMap<string, SaleState>,
  sort: GallerySort = DEFAULT_GALLERY_SORT,
): T[] {
  if (sort === "newest" || sale.size === 0) return refs.slice()
  return refs
    .map((ref, idx) => ({ ref, idx, st: sale.get(saleKey(ref.contract, ref.tokenId)) }))
    .sort((a, b) => {
      const ra = a.st?.rank ?? 2
      const rb = b.st?.rank ?? 2
      if (ra !== rb) return ra - rb
      const ea = a.st?.endsAt ?? null
      const eb = b.st?.endsAt ?? null
      if (ea !== eb) {
        if (ea == null) return 1
        if (eb == null) return -1
        return ea - eb
      }
      return a.idx - b.idx
    })
    .map((x) => x.ref)
}
