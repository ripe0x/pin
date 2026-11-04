/**
 * `worker_cursors` reads/writes shared by every cursored scanner.
 *
 * Monotonic writes (audit L2): the upsert keeps
 * GREATEST(existing, proposed), so a scheduled run racing an on-demand
 * refresh (or any two writers of the same scope) can't move a cursor
 * backwards and re-open a range, and a scanner that replays an overlap
 * below its cursor (see `scanWindow`) can't lower it either. An operator
 * who really wants to rewind a cursor does it with a direct UPDATE.
 *
 * Takes the postgres client as an argument (no db.ts import) so it is
 * unit-testable without DATABASE_URL.
 */
import { toPgTextArray } from "./backoff.ts"

export type CursorSql = {
  unsafe: (query: string, params?: string[]) => PromiseLike<unknown>
}

export const CURSOR_UPSERT_SQL =
  "INSERT INTO worker_cursors (task, scope, last_block, last_run_at) " +
  "VALUES ($1, $2, $3::bigint, NOW()) " +
  "ON CONFLICT (task, scope) DO UPDATE SET " +
  "last_block = GREATEST(worker_cursors.last_block, EXCLUDED.last_block), " +
  "last_run_at = NOW()"

export const CURSOR_READ_SQL =
  "SELECT last_block::text AS last_block FROM worker_cursors " +
  "WHERE task = $1 AND scope = $2 LIMIT 1"

/** CURSOR_UPSERT_SQL for many scopes of one task in one statement. */
export const CURSOR_UPSERT_MANY_SQL =
  "INSERT INTO worker_cursors (task, scope, last_block, last_run_at) " +
  "SELECT $1, s, $3::bigint, NOW() FROM unnest($2::text[]) AS s " +
  "ON CONFLICT (task, scope) DO UPDATE SET " +
  "last_block = GREATEST(worker_cursors.last_block, EXCLUDED.last_block), " +
  "last_run_at = NOW()"

/** What CURSOR_UPSERT_SQL stores, for reasoning and tests. */
export function nextCursorValue(current: bigint | null, proposed: bigint): bigint {
  return current === null || proposed > current ? proposed : current
}

export async function readCursor(
  sql: CursorSql, task: string, scope: string,
): Promise<bigint | null> {
  const rows = (await sql.unsafe(CURSOR_READ_SQL, [task, scope])) as Array<{ last_block: string }>
  return rows[0] ? BigInt(rows[0].last_block) : null
}

export async function advanceCursor(
  sql: CursorSql, task: string, scope: string, lastBlock: bigint,
): Promise<void> {
  await sql.unsafe(CURSOR_UPSERT_SQL, [task, scope, lastBlock.toString()])
}

export async function advanceCursors(
  sql: CursorSql, task: string, scopes: string[], lastBlock: bigint,
): Promise<void> {
  if (scopes.length === 0) return
  await sql.unsafe(CURSOR_UPSERT_MANY_SQL, [task, toPgTextArray(scopes), lastBlock.toString()])
}

/**
 * The block range a cursored scanner should fetch this tick, or null
 * when there is nothing new to scan.
 *
 *   - No cursor yet: start at `initialFrom` (deploy block, earliest mint).
 *   - Cursor at or past the safe head: nothing new. The overlap is NOT
 *     replayed on its own; it only rides along with new blocks, so an
 *     idle scope costs no RPC.
 *   - Otherwise: resume at `cursor + 1 - overlap`, floored at
 *     `initialFrom`, so the last `overlap` blocks are re-read. Only for
 *     scanners whose writes are idempotent.
 */
export function scanWindow(args: {
  cursor: bigint | null
  initialFrom: bigint
  safeHead: bigint
  overlap?: bigint
}): { from: bigint; to: bigint } | null {
  const { cursor, initialFrom, safeHead } = args
  const overlap = args.overlap ?? 0n
  let from: bigint
  if (cursor === null) {
    from = initialFrom
  } else {
    if (cursor >= safeHead) return null
    from = cursor + 1n - overlap
    if (from < initialFrom) from = initialFrom
    if (from < 0n) from = 0n
  }
  if (from > safeHead) return null
  return { from, to: safeHead }
}
