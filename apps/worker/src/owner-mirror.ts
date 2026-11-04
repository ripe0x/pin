/**
 * Shared-contract ownership mirror: Ponder's `token_ownership` into the
 * public `token_owners` read model (#296, ownership C2 worker side).
 *
 * The problem: the Foundation shared (0x3b3e…) and SuperRare V2 (0xb932…)
 * 1/1 contracts are excluded from scan-token-transfers (scanning every
 * Transfer on them is the unbounded scan v2 refuses), so a shared token's
 * `token_owners` row was the ownerOf answer read once, right after the
 * mint scanner found it, and never updated. Every resale left the
 * displayed owner wrong. SR V2 tokens never got a row at all.
 *
 * Ponder already follows both contracts, and from ponder_v5 its
 * `token_ownership` table holds the current owner from every Transfer
 * (mint, sale, gift, burn):
 *   - SR V2 ('superrare-v2'): subscribed from below the contract's
 *     deploy, so every token has a row. Complete.
 *   - Foundation ('foundation-shared'): subscribed from FND_START_BLOCK.
 *     Complete for tokens minted since; an older token has a row only if
 *     it moved after that block.
 * Mirroring it is Postgres-to-Postgres: zero RPC, no ownerOf sweep.
 *
 * What gets mirrored: rows for tokens PND surfaces, i.e. present in
 * public.artist_tokens (the worker's fnd-shared rows, known artists only)
 * or in Ponder's own fnd_artist_tokens / srv2_artist_tokens (every mint
 * Ponder saw, the same set artist pages already read). Ponder rows for
 * other old FND tokens that happened to move after FND_START_BLOCK are
 * skipped: PND shows nothing for them.
 *
 * Finality: only rows whose last_block is at or below the worker's
 * finalized safe head (finality.ts) are copied. Ponder follows the tip
 * and rolls back reorged blocks in place; a row copied from an orphaned
 * block would have no later Transfer to correct it here. A finalized
 * row never changes except by a newer Transfer, which has a higher
 * (block, log index), so the mirror can be strictly monotonic.
 *
 * Precedence (`ownerMirrorWins`, and the same rule in SQL): the incoming
 * Ponder row replaces the existing token_owners row iff there is none,
 * or the existing (transferred_at_block, transferred_at_log_index) is
 * at or below the incoming (last_block, log_index), and something
 * actually differs. Legacy rows for these contracts are ownerOf answers
 * stored at block 0, so the first Ponder evidence always wins; a Ponder
 * row never loses to an older one; a replay is a no-op.
 *
 * Three passes per tick (mirror-shared-owners.ts runs them):
 *   1. incremental: Ponder rows with last_block in
 *      [cursor + 1 - overlap, safe head]. The cursor (worker_cursors,
 *      scope = INDEXER_SCHEMA, so a schema cutover starts a fresh full
 *      mirror) advances to the highest last_block seen, never past what
 *      Ponder has written, and never backwards (cursors.ts GREATEST).
 *      The overlap re-reads a block Ponder had only partly flushed.
 *   2. late-tracked: public.artist_tokens fnd-shared rows whose owner row
 *      is missing or not from Ponder while Ponder has one. This is the
 *      only way a token becomes tracked after its last Transfer: a newly
 *      known artist's pre-FND_START_BLOCK tokens, copied in by the seed.
 *      (Ponder's own artist-token rows appear in the same block as their
 *      mint Transfer, so pass 1 sees them.)
 *   3. reconcile: the full diff, on the first tick after boot and every
 *      few hours, as a safety net. Same upsert, so it only ever writes
 *      rows passes 1 and 2 missed.
 *
 * Pure module (SQL builders + rules), unit-tested in owner-mirror.test.ts.
 */

/** The Ponder subscription start for FoundationNFT (ponder.config.ts FND_START_BLOCK). */
export const FND_START_BLOCK = 24_973_294n

export const FOUNDATION_SHARED = "0x3b3ee1931dc30c1957379fac9aba94d1c48a5405"
export const SUPERRARE_V2_SHARED = "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0"

/** token_owners.source for a row mirrored from Ponder's `source`. */
export function mirrorSource(ponderSource: string): string {
  return `ponder:${ponderSource}`
}

/** token_owners.source for the one-time ownerOf gap fill. */
export const OWNEROF_SOURCE = "ownerof"

export type OwnerObservation = {
  owner: string
  block: bigint
  /** -1 when unknown (legacy writers). */
  logIndex: bigint
  source: string | null
}

/**
 * Whether `incoming` replaces `existing` in token_owners. The SQL upsert
 * in `buildOwnerMirrorSql` encodes the same rule; keep them in step.
 */
export function ownerMirrorWins(
  existing: OwnerObservation | null,
  incoming: OwnerObservation,
): boolean {
  if (existing === null) return true
  const same =
    existing.owner === incoming.owner &&
    existing.block === incoming.block &&
    existing.logIndex === incoming.logIndex &&
    existing.source === incoming.source
  if (same) return false
  if (existing.block !== incoming.block) return existing.block < incoming.block
  return existing.logIndex <= incoming.logIndex
}

/**
 * Next mirror cursor after an incremental pass that saw Ponder rows up to
 * `maxSeen` (null when it saw none). A `truncated` pass (it hit its row
 * limit) may have read only part of its last block, so the cursor stops
 * one block short of it; the replay overlap re-reads the rest. Never past
 * the safe head the pass was bounded by, never backwards (the DB write
 * uses GREATEST as well).
 */
export function nextMirrorCursor(
  cursor: bigint | null,
  maxSeen: bigint | null,
  safeHead: bigint,
  truncated = false,
): bigint | null {
  if (maxSeen === null) return cursor
  let proposed = truncated ? maxSeen - 1n : maxSeen
  if (proposed > safeHead) proposed = safeHead
  if (proposed < 0n) return cursor
  return cursor === null || proposed > cursor ? proposed : cursor
}

export type MirrorMode = "incremental" | "late-tracked" | "reconcile"

/** Tokens PND surfaces (see the header). `o` is the Ponder row. */
function trackedPredicate(schema: string): string {
  return `(
      EXISTS (SELECT 1 FROM ${schema}.srv2_artist_tokens s WHERE s.id = o.id)
      OR EXISTS (SELECT 1 FROM ${schema}.fnd_artist_tokens f WHERE f.id = o.id)
      OR EXISTS (
        SELECT 1 FROM public.artist_tokens a
        WHERE a.contract = o.contract AND a.token_id = o.token_id::text
      )
    )`
}

/** The token_owners row a Ponder row would become, as a SELECT list. */
const PONDER_ROW_COLUMNS = `o.contract AS contract,
         o.token_id::text AS token_id,
         o.owner AS owner,
         o.last_block::bigint AS transferred_at_block,
         o.log_index::bigint AS transferred_at_log_index,
         o.block_time::bigint AS transferred_at_time,
         o.tx_hash AS tx_hash,
         'ponder:' || o.source AS source`

/** Ponder rows already identical in token_owners (nothing to write). */
const ALREADY_MIRRORED = `EXISTS (
        SELECT 1 FROM public.token_owners t
        WHERE t.contract = o.contract AND t.token_id = o.token_id::text
          AND t.owner = o.owner
          AND t.transferred_at_block = o.last_block
          AND t.transferred_at_log_index = o.log_index
          AND t.source = 'ponder:' || o.source
      )`

/**
 * One mirror pass as a single statement. Parameters (`ownerMirrorParams`):
 *   incremental   $1 lowest last_block to read, $2 safe head, $3 row limit
 *   late-tracked  $1 safe head, $2 row limit
 *   reconcile     $1 safe head, $2 row limit
 * Rows are read in (last_block, id) order up to the limit, so one
 * statement stays well inside the worker's statement_timeout even on the
 * first full mirror after a schema cutover; the caller loops while a
 * pass comes back full. Returns one row: { seen, written, max_block }
 * where max_block is the highest last_block among ALL Ponder rows read
 * (tracked or not), for the incremental cursor, and written counts rows
 * inserted or updated.
 *
 * Ponder stores hex lowercase and its row id is `${contract}-${tokenId}`
 * (lowercase), so every join is an index lookup with no lower().
 * `schema` must already be sanitized (indexer-schema.ts).
 */
export function buildOwnerMirrorSql(schema: string, mode: MirrorMode): string {
  let from: string
  let where: string
  let limit: string
  switch (mode) {
    case "incremental":
      from = `${schema}.token_ownership o`
      where = `o.last_block >= $1::numeric AND o.last_block <= $2::numeric`
      limit = "$3"
      break
    case "late-tracked":
      // Driven from the small known-artist set, joined to Ponder by PK.
      from = `public.artist_tokens a
       JOIN ${schema}.token_ownership o ON o.id = a.contract || '-' || a.token_id`
      where = `a.platform = 'fnd-shared'
         AND o.last_block <= $1::numeric
         AND NOT EXISTS (
           SELECT 1 FROM public.token_owners t
           WHERE t.contract = a.contract AND t.token_id = a.token_id
             AND t.source LIKE 'ponder:%'
         )`
      limit = "$2"
      break
    case "reconcile":
      from = `${schema}.token_ownership o`
      where = `o.last_block <= $1::numeric AND NOT ${ALREADY_MIRRORED}`
      limit = "$2"
      break
  }
  return `WITH src_all AS (
       SELECT ${PONDER_ROW_COLUMNS},
              ${trackedPredicate(schema)} AS tracked
       FROM ${from}
       WHERE ${where}
       ORDER BY o.last_block, o.id
       LIMIT ${limit}::int
     ),
     up AS (
       INSERT INTO public.token_owners
         (contract, token_id, owner, transferred_at_block, transferred_at_log_index,
          transferred_at_time, tx_hash, source)
       SELECT contract, token_id, owner, transferred_at_block, transferred_at_log_index,
              transferred_at_time, tx_hash, source
       FROM src_all
       WHERE tracked
       ON CONFLICT (contract, token_id) DO UPDATE SET
         owner = EXCLUDED.owner,
         transferred_at_block = EXCLUDED.transferred_at_block,
         transferred_at_log_index = EXCLUDED.transferred_at_log_index,
         transferred_at_time = EXCLUDED.transferred_at_time,
         tx_hash = EXCLUDED.tx_hash,
         source = EXCLUDED.source
       WHERE (token_owners.owner, token_owners.transferred_at_block,
              token_owners.transferred_at_log_index, token_owners.source)
             IS DISTINCT FROM
             (EXCLUDED.owner, EXCLUDED.transferred_at_block,
              EXCLUDED.transferred_at_log_index, EXCLUDED.source)
         AND (token_owners.transferred_at_block, token_owners.transferred_at_log_index)
             <= (EXCLUDED.transferred_at_block, EXCLUDED.transferred_at_log_index)
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM src_all)::int AS seen,
            (SELECT count(*) FROM up)::int AS written,
            (SELECT max(transferred_at_block) FROM src_all)::text AS max_block`
}

/** Positional parameters for `buildOwnerMirrorSql(schema, mode)`. */
export function ownerMirrorParams(
  mode: MirrorMode, from: bigint, safeHead: bigint, limit: number,
): string[] {
  return mode === "incremental"
    ? [from.toString(), safeHead.toString(), String(limit)]
    : [safeHead.toString(), String(limit)]
}

/**
 * Foundation shared tokens PND tracks that no source can answer yet:
 * minted before FND_START_BLOCK, no token_owners row, and no Ponder row
 * (they haven't moved since FND_START_BLOCK). In practice these are the
 * historical tokens copied in from the discovery seed, which (unlike the
 * live sweep) never ran ownerOf. Parameters: $1 task (scan_backoff),
 * $2 FND_START_BLOCK, $3 limit.
 *
 * Why one ownerOf each is enough, forever: Ponder's FoundationNFT
 * Transfer stream is complete from FND_START_BLOCK. A token with no
 * Transfer since then has had the same owner since then, so an ownerOf
 * read at any later block is its current owner until the next Transfer,
 * and that Transfer lands in token_ownership and is mirrored over this
 * row (stored at block 0, so any Ponder evidence wins). No recurring
 * sweep is needed or wanted (#296).
 */
export function ownerOfGapCandidatesSql(schema: string): string {
  return `SELECT a.contract, a.token_id, b.failures
     FROM public.artist_tokens a
     LEFT JOIN public.scan_backoff b
       ON b.task = $1 AND b.scope = 'ownerof:' || a.contract || ':' || a.token_id
     WHERE a.platform = 'fnd-shared'
       AND a.contract = '${FOUNDATION_SHARED}'
       AND a.mint_block < $2::bigint
       AND NOT EXISTS (
         SELECT 1 FROM public.token_owners t
         WHERE t.contract = a.contract AND t.token_id = a.token_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM ${schema}.token_ownership o
         WHERE o.id = a.contract || '-' || a.token_id
       )
       AND (b.retry_at IS NULL OR b.retry_at <= NOW())
     ORDER BY COALESCE(b.failures, 0), a.mint_block, a.token_id
     LIMIT $3::int`
}

/** Insert for an ownerOf answer; never overwrites an existing row. */
export const OWNEROF_INSERT_SQL =
  "INSERT INTO public.token_owners " +
  "(contract, token_id, owner, transferred_at_block, transferred_at_log_index, " +
  "transferred_at_time, tx_hash, source) " +
  "VALUES ($1, $2, $3, 0, -1, 0, NULL, $4) " +
  "ON CONFLICT (contract, token_id) DO NOTHING"
