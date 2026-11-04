/**
 * Mirror current owners of the Foundation shared and SuperRare V2 1/1s
 * from Ponder's `token_ownership` into `public.token_owners` (#296).
 *
 * Replaces "resolve once at mint, never update" (resolve-owner.ts) for the
 * shared contracts: owner-mirror.ts has the rules (tracked set, finality,
 * precedence, the three passes). This task is Postgres-to-Postgres, zero
 * RPC except:
 *   - the finalized safe head (finality.ts; cached and shared with every
 *     other scanner, so usually free), and
 *   - a one-time ownerOf per historical Foundation token no source can
 *     answer (owner-mirror.ts `ownerOfGapCandidatesSql` explains why one
 *     read is enough forever): one multicall per tick, at most
 *     OWNEROF_BATCH tokens, until the gap drains. A token whose ownerOf
 *     reverts (burned before FND_START_BLOCK) backs off per token for a
 *     day, doubling to two weeks (backoff.ts), so it costs one call slot
 *     a fortnight at most.
 *
 * Schema guard: `token_ownership` exists from ponder_v5. While
 * INDEXER_SCHEMA still points at a schema without it (ponder_v4 today),
 * the task is a logged no-op: nothing changes until the cutover. The
 * cursor is scoped by schema name, so the first tick after a cutover
 * mirrors the new schema in full (in bounded statements).
 */
import { getAddress, type Address } from "viem"
import { sql } from "../db.ts"
import { client, safeHead } from "../rpc.ts"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"
import type { TaskResult } from "../scheduler.ts"
import { advanceCursor, readCursor } from "../cursors.ts"
import { replayOverlap } from "../finality.ts"
import { clearBackoff, recordFailure, type BackoffPolicy, type BackoffRow } from "../backoff.ts"
import {
  FND_START_BLOCK, OWNEROF_INSERT_SQL, OWNEROF_SOURCE,
  buildOwnerMirrorSql, nextMirrorCursor, ownerMirrorParams, ownerOfGapCandidatesSql,
  type MirrorMode,
} from "../owner-mirror.ts"

const TASK = "mirror-shared-owners"
// Rows per mirror statement; the first full mirror after a cutover
// (~every SR V2 token plus FND) takes a few of these.
const ROW_LIMIT = 20_000
// Incremental statements per tick before yielding to the next tick.
const MAX_INCREMENTAL_PASSES = 10
const RECONCILE_EVERY_MS = 6 * 60 * 60_000
const OWNEROF_BATCH = 100
// ownerOf reverts for a token that no longer exists (burned before
// FND_START_BLOCK, so Ponder has no Transfer for it). Deterministic:
// retry daily, doubling to every two weeks (under prune-retention's
// 30-day cutoff for untouched scan_backoff rows, so the count survives).
const OWNEROF_BACKOFF: BackoffPolicy = { baseMs: 24 * 60 * 60_000, maxMs: 14 * 24 * 60 * 60_000 }

const ownerOfAbi = [{
  type: "function" as const,
  name: "ownerOf",
  stateMutability: "view" as const,
  inputs: [{ name: "tokenId", type: "uint256" as const }],
  outputs: [{ name: "", type: "address" as const }],
}] as const

let lastReconcileAt = 0
let warnedMissing = false

async function sourceTablesExist(): Promise<boolean> {
  const rows = (await sql.unsafe(
    `SELECT (to_regclass($1) IS NOT NULL
         AND to_regclass($2) IS NOT NULL
         AND to_regclass($3) IS NOT NULL) AS ok`,
    [
      `${INDEXER_SCHEMA}.token_ownership`,
      `${INDEXER_SCHEMA}.fnd_artist_tokens`,
      `${INDEXER_SCHEMA}.srv2_artist_tokens`,
    ],
  )) as Array<{ ok: boolean }>
  return rows[0]?.ok === true
}

type PassRow = { seen: number; written: number; max_block: string | null }

async function runPass(
  mode: MirrorMode, from: bigint, head: bigint,
): Promise<PassRow> {
  const rows = (await sql.unsafe(
    buildOwnerMirrorSql(INDEXER_SCHEMA, mode),
    ownerMirrorParams(mode, from, head, ROW_LIMIT),
  )) as PassRow[]
  return rows[0] ?? { seen: 0, written: 0, max_block: null }
}

export async function mirrorSharedOwners(): Promise<TaskResult> {
  if (!(await sourceTablesExist())) {
    if (!warnedMissing) {
      warnedMissing = true
      console.warn(
        `[${TASK}] ${INDEXER_SCHEMA}.token_ownership is absent (ponder_v5+); ` +
        "shared-contract owners stay as resolved at mint until the cutover",
      )
    }
    return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  }
  warnedMissing = false

  const head = await safeHead.get()
  let rpcCalls = head.rpcCalls
  let rowsWritten = 0
  const errors: string[] = []

  // 1. Incremental, by Ponder's last_block.
  const startCursor = await readCursor(sql, TASK, INDEXER_SCHEMA)
  let cursor = startCursor
  for (let i = 0; i < MAX_INCREMENTAL_PASSES; i++) {
    let from = cursor === null ? 0n : cursor + 1n - replayOverlap()
    if (from < 0n) from = 0n
    if (from > head.block) break
    const r = await runPass("incremental", from, head.block)
    rowsWritten += r.written
    const truncated = r.seen >= ROW_LIMIT
    const next = nextMirrorCursor(
      cursor, r.max_block === null ? null : BigInt(r.max_block), head.block, truncated,
    )
    if (next !== null && next !== cursor) {
      await advanceCursor(sql, TASK, INDEXER_SCHEMA, next)
      cursor = next
    } else if (truncated) {
      // A full page that couldn't move the cursor (> ROW_LIMIT rows inside
      // the replay overlap): stop rather than spin; it's surfaced.
      errors.push(`incremental pass stuck at ${cursor}: ${r.seen} rows within the replay overlap`)
      break
    }
    if (!truncated) break
  }

  // 2. Late-tracked: newly known artists' historical FND tokens.
  const late = await runPass("late-tracked", 0n, head.block)
  rowsWritten += late.written

  // 3. Safety-net reconcile. Skipped on the tick that started a fresh
  // schema from scratch (pass 1 just read everything).
  const now = Date.now()
  if (startCursor === null) {
    lastReconcileAt = now
  } else if (now - lastReconcileAt >= RECONCILE_EVERY_MS) {
    const r = await runPass("reconcile", 0n, head.block)
    rowsWritten += r.written
    if (r.written > 0) {
      console.warn(`[${TASK}] reconcile wrote ${r.written} row(s) the incremental passes missed`)
    }
    // A full page that still wrote rows has more behind it: go again next tick.
    if (!(r.seen >= ROW_LIMIT && r.written > 0)) lastReconcileAt = now
  }

  // 4. One-time ownerOf for historical FND tokens with no evidence at all.
  const gap = await fillOwnerOfGap(head.block)
  rpcCalls += gap.rpcCalls
  rowsWritten += gap.rowsWritten
  if (gap.error) errors.push(gap.error)

  return { scopeCount: 1, rpcCalls, rowsWritten, errors }
}

async function fillOwnerOfGap(
  atBlock: bigint,
): Promise<{ rpcCalls: number; rowsWritten: number; error: string | null }> {
  const candidates = (await sql.unsafe(
    ownerOfGapCandidatesSql(INDEXER_SCHEMA),
    [TASK, FND_START_BLOCK.toString(), String(OWNEROF_BATCH)],
  )) as Array<{ contract: string; token_id: string; failures: number | null }>
  if (candidates.length === 0) return { rpcCalls: 0, rowsWritten: 0, error: null }

  let results: Array<{ status: "success"; result: unknown } | { status: "failure"; error: unknown }>
  try {
    // One eth_call (batchSize 0 = no chunking) at the finalized head, so
    // the answer can't come from a block that later reorgs away.
    results = (await client.multicall({
      contracts: candidates.map((c) => ({
        address: getAddress(c.contract) as Address,
        abi: ownerOfAbi,
        functionName: "ownerOf" as const,
        args: [BigInt(c.token_id)] as const,
      })),
      allowFailure: true,
      batchSize: 0,
      blockNumber: atBlock,
    })) as typeof results
  } catch (err) {
    // Transport failure: nothing learned, retry next tick.
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err)
    return { rpcCalls: 1, rowsWritten: 0, error: `ownerOf gap fill: ${msg}` }
  }

  let rowsWritten = 0
  const recovered: string[] = []
  const now = new Date()
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const r = results[i]
    const scope = `ownerof:${c.contract}:${c.token_id}`
    if (r?.status === "success" && typeof r.result === "string") {
      const res = await sql.unsafe(OWNEROF_INSERT_SQL, [
        c.contract, c.token_id, r.result.toLowerCase(), OWNEROF_SOURCE,
      ])
      rowsWritten += (res as unknown as { count: number }).count ?? 0
      if (c.failures !== null) recovered.push(scope)
    } else {
      const prev: BackoffRow | undefined = c.failures === null ? undefined : {
        scope, failures: Number(c.failures), retryAt: now, lastError: null,
      }
      const reason = r?.status === "failure" && r.error instanceof Error
        ? r.error.message.split("\n")[0]
        : "ownerOf reverted"
      await recordFailure(sql, TASK, prev, scope, reason, OWNEROF_BACKOFF, now)
        .catch((err) => console.error(`[${TASK}] record failure ${scope}:`, err))
    }
  }
  await clearBackoff(sql, TASK, recovered)
    .catch((err) => console.error(`[${TASK}] clear backoff:`, err))
  return { rpcCalls: 1, rowsWritten, error: null }
}
