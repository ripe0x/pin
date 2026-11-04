// No "server-only" guard: this module only builds SQL strings, encodes
// cursors and orders plain rows, so the plain-Node test runner can import it.

/**
 * A wallet's current holdings among the works PND indexes (#296), as one
 * keyset-paginated list. Pure Postgres: no ownerOf, getLogs or wallet-NFT
 * API call on the request path.
 *
 * Sources, in precedence order when one (contract, token_id) appears in
 * more than one (lower rank wins):
 *   0. surface          Surface collections' `collection_tokens.owner` in
 *                       INDEXER_SCHEMA (ponder_v5+; Ponder follows every
 *                       Transfer of every factory child, so it's complete).
 *                       Only included when the column exists.
 *   1. erc1155_balances `token_1155_balances` (worker scan-1155-balances),
 *                       balance > 0. Covers known artists' own ERC-1155
 *                       contracts.
 *   2. token_owners     The worker's ERC-721 current owners (per-artist
 *                       contracts, plus the Foundation / SR V2 shared
 *                       1/1s mirrored from Ponder). Rows on a contract the
 *                       1155 ledger has seen are dropped: a token_owners
 *                       row there is a single-owner guess (the Manifold
 *                       fast path writes one) and the balances are the
 *                       real answer.
 *
 * Coverage: "owned among work PND indexes", not every NFT the wallet
 * holds. Each row says which source answered and as of which block.
 *
 * Order: the block the holding last changed (acquired), newest first,
 * then contract and token id, all descending, compared byte-wise
 * (COLLATE "C") so SQL and `sortHoldings` agree on every database. The
 * cursor is that triple for the last row of a page; `(block, contract,
 * token_id) < cursor` continues strictly after it, so pages never
 * overlap or skip even when holdings change between requests (a holding
 * that moves to a newer block shows up at the front, not mid-list).
 */

export const HOLDING_SOURCES = ["surface", "erc1155_balances", "token_owners"] as const
export type HoldingSource = (typeof HOLDING_SOURCES)[number]

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
export const DEFAULT_HOLDINGS_LIMIT = 48
export const MAX_HOLDINGS_LIMIT = 200

export type HoldingCursor = { block: bigint; contract: string; tokenId: string }

export type HoldingRow = {
  contract: string
  token_id: string
  standard: "erc721" | "erc1155"
  /** Decimal string (uint256-safe). 1 for ERC-721. */
  balance: string
  /** Block the holding last changed; 0 when only an ownerOf snapshot is known. */
  block: string
  source: HoldingSource
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const UINT_RE = /^[0-9]{1,78}$/

export function clampHoldingsLimit(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_HOLDINGS_LIMIT
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_HOLDINGS_LIMIT
  return Math.min(MAX_HOLDINGS_LIMIT, Math.max(1, Math.trunc(n)))
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url")
}

function fromBase64Url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8")
}

export function encodeHoldingCursor(c: HoldingCursor): string {
  return toBase64Url(`${c.block.toString()}:${c.contract}:${c.tokenId}`)
}

/** Null for anything that isn't a cursor this module produced. */
export function decodeHoldingCursor(raw: string | null | undefined): HoldingCursor | null {
  if (!raw || raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
  const parts = fromBase64Url(raw).split(":")
  if (parts.length !== 3) return null
  const [block, contract, tokenId] = parts
  if (!UINT_RE.test(block) || !ADDRESS_RE.test(contract) || !UINT_RE.test(tokenId)) return null
  return { block: BigInt(block), contract, tokenId }
}

/**
 * The page query. Parameters:
 *   $1 wallet (lowercase)   $2 cursor block (text or null)
 *   $3 cursor contract      $4 cursor token id      $5 limit
 * Returns `total` (distinct holdings, ignoring the cursor) on every row,
 * and exactly one all-null row besides `total` when the page is empty, so
 * the count is always available.
 *
 * `schema` must already be sanitized (lib/indexer-schema.ts). Probe
 * before calling (`HOLDINGS_PROBE_SQL`):
 * `surface`: whether `<schema>.collection_tokens` has the ponder_v5
 * `owner` / `owner_updated_at_block` columns;
 * `erc1155`: whether migration 034's tables exist.
 *
 * `excludeOwnWorks`: drop tokens PND attributes to the wallet itself
 * (artist_tokens, Ponder's Foundation / SR V2 shared 1/1s; the sources of
 * artist-token-refs.ts), from the page and from `total`. The profile's
 * Collected tab (#299) uses it so an artist's unsold inventory sits under
 * Created, not Collected.
 */
export function collectorHoldingsSql(
  schema: string, opts: { surface: boolean; erc1155: boolean; excludeOwnWorks?: boolean },
): string {
  const rank = (s: HoldingSource) => HOLDING_SOURCES.indexOf(s)
  const ownWorks = opts.excludeOwnWorks
    ? `WHERE NOT EXISTS (SELECT 1 FROM artist_tokens a
                     WHERE a.contract = h.contract AND a.token_id = h.token_id AND a.artist = $1)
         AND NOT EXISTS (SELECT 1 FROM ${schema}.fnd_artist_tokens f
                     WHERE f.contract = h.contract AND f.token_id = h.token_id::numeric
                       AND lower(f.creator) = $1)
         AND NOT EXISTS (SELECT 1 FROM ${schema}.srv2_artist_tokens v
                     WHERE v.contract = h.contract AND v.token_id = h.token_id::numeric
                       AND lower(v.creator) = $1)`
    : ""
  const notErc1155 = opts.erc1155
    ? "AND NOT EXISTS (SELECT 1 FROM token_1155_transfers x WHERE x.contract = o.contract)"
    : ""
  const erc1155 = opts.erc1155
    ? `UNION ALL
       SELECT b.contract, b.token_id, 'erc1155'::text, b.balance,
              b.updated_block, 'erc1155_balances'::text, ${rank("erc1155_balances")}
       FROM token_1155_balances b
       WHERE b.holder = $1 AND b.balance > 0`
    : ""
  const surface = opts.surface
    ? `UNION ALL
       SELECT ct.collection::text, ct.token_id::text, 'erc721'::text, 1::numeric,
              ct.owner_updated_at_block::bigint, 'surface'::text, ${rank("surface")}
       FROM ${schema}.collection_tokens ct
       WHERE ct.owner = $1`
    : ""
  return `WITH holdings AS (
       SELECT o.contract, o.token_id, 'erc721'::text AS standard, 1::numeric AS balance,
              o.transferred_at_block::bigint AS block, 'token_owners'::text AS source,
              ${rank("token_owners")} AS src_rank
       FROM token_owners o
       WHERE o.owner = $1
         ${notErc1155}
       ${erc1155}
       ${surface}
     ),
     deduped AS (
       SELECT DISTINCT ON (h.contract, h.token_id)
              h.contract, h.token_id, h.standard, h.balance, h.block, h.source
       FROM holdings h
       ${ownWorks}
       ORDER BY h.contract, h.token_id, h.src_rank
     ),
     page AS (
       SELECT d.* FROM deduped d
       WHERE $2::bigint IS NULL
          OR (d.block, d.contract COLLATE "C", d.token_id COLLATE "C")
             < ($2::bigint, $3::text COLLATE "C", $4::text COLLATE "C")
       ORDER BY d.block DESC, d.contract COLLATE "C" DESC, d.token_id COLLATE "C" DESC
       LIMIT $5::int
     )
     SELECT t.total, p.contract, p.token_id, p.standard,
            p.balance::text AS balance, p.block::text AS block, p.source
     FROM (SELECT count(*)::int AS total FROM deduped) t
     LEFT JOIN page p ON true
     ORDER BY p.block DESC, p.contract COLLATE "C" DESC, p.token_id COLLATE "C" DESC`
}

/**
 * One round trip that says which optional sources exist. $1 = schema.
 * Columns: surface, erc1155 (booleans).
 */
export const HOLDINGS_PROBE_SQL = `SELECT
     (SELECT count(*) = 2 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'collection_tokens'
         AND column_name IN ('owner', 'owner_updated_at_block')) AS surface,
     (to_regclass('public.token_1155_balances') IS NOT NULL
       AND to_regclass('public.token_1155_transfers') IS NOT NULL) AS erc1155`

export function collectorHoldingsParams(
  wallet: string, cursor: HoldingCursor | null, limit: number,
): Array<string | number | null> {
  return [
    wallet.toLowerCase(),
    cursor ? cursor.block.toString() : null,
    cursor ? cursor.contract : null,
    cursor ? cursor.tokenId : null,
    limit,
  ]
}

// ── JS reference of the SQL's dedupe + order (used by tests) ──────────────

const byteCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Descending (block, contract, token_id); negative when `a` sorts first. */
export function compareHoldings(
  a: Pick<HoldingRow, "block" | "contract" | "token_id">,
  b: Pick<HoldingRow, "block" | "contract" | "token_id">,
): number {
  const ab = BigInt(a.block)
  const bb = BigInt(b.block)
  if (ab !== bb) return ab > bb ? -1 : 1
  return -byteCmp(a.contract, b.contract) || -byteCmp(a.token_id, b.token_id)
}

/** One row per (contract, token_id) by source precedence, then sorted. */
export function dedupeAndSortHoldings<T extends HoldingRow>(rows: T[]): T[] {
  const best = new Map<string, T>()
  for (const r of rows) {
    const key = `${r.contract}:${r.token_id}`
    const cur = best.get(key)
    if (!cur || HOLDING_SOURCES.indexOf(r.source) < HOLDING_SOURCES.indexOf(cur.source)) best.set(key, r)
  }
  return Array.from(best.values()).sort(compareHoldings)
}

/** The rows after `cursor` (exclusive), as the SQL keyset predicate selects them. */
export function afterCursor<T extends HoldingRow>(sorted: T[], cursor: HoldingCursor | null): T[] {
  if (!cursor) return sorted
  const c = { block: cursor.block.toString(), contract: cursor.contract, token_id: cursor.tokenId }
  return sorted.filter((r) => compareHoldings(r, c) > 0)
}

export function cursorAfter(row: Pick<HoldingRow, "block" | "contract" | "token_id">): string {
  return encodeHoldingCursor({ block: BigInt(row.block), contract: row.contract, tokenId: row.token_id })
}
