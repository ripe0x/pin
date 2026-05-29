/**
 * Single-process task scheduler.
 *
 * One in-memory `Map<TaskName, RunState>` tracks per-task dedup + lag.
 * Tasks self-pace via setInterval; each one acquires its slot, runs the
 * body, releases. Long-running tasks don't block other tasks because each
 * task has its own interval and `running` flag.
 *
 * Why no Redis/BullMQ: at this scale (~hundreds of artists, low-tens of
 * tasks, hours of slack across cadences), in-memory dedup is sufficient
 * and saves an entire service. Revisit if the worker can't keep up;
 * symptom will be `worker_iterations.duration_ms` climbing past the
 * task's own interval.
 */
import { sql } from "./db.ts"
import { seedKnownArtists } from "./tasks/seed-known-artists.ts"
import { warmContractIdentity } from "./tasks/warm-contract-identity.ts"
import { warmEns } from "./tasks/warm-ens.ts"
import { warmMetadata } from "./tasks/warm-metadata.ts"
import { scanFndCollections } from "./tasks/scan-fnd-collections.ts"
import { scanFndShared } from "./tasks/scan-fnd-shared.ts"
import { scanMintClones } from "./tasks/scan-mint-clones.ts"
import { scanTlClones } from "./tasks/scan-tl-clones.ts"
import { scanManifold } from "./tasks/scan-manifold.ts"
import { scanTokenTransfers } from "./tasks/scan-token-transfers.ts"
import { ponderDriftCheck } from "./tasks/ponder-drift-check.ts"
import { refreshArtist } from "./tasks/refresh-artist.ts"
import { refreshToken } from "./tasks/refresh-token.ts"
import { scan1155Stats } from "./tasks/scan-1155-stats.ts"
import { scanSrv2ActiveAuctions } from "./tasks/scan-srv2-active-auctions.ts"
import { scanTlActiveAuctions } from "./tasks/scan-tl-active-auctions.ts"
import { scanPndAuctionTokens } from "./tasks/scan-pnd-auction-tokens.ts"
import { probeCidAvailability } from "./tasks/probe-cid-availability.ts"

type TaskName =
  | "seed-known-artists"
  | "warm-contract-identity"
  | "warm-ens"
  | "warm-metadata"
  | "scan-fnd-collections"
  | "scan-fnd-shared"
  | "scan-mint-clones"
  | "scan-tl-clones"
  | "scan-manifold"
  | "scan-token-transfers"
  | "scan-1155-stats"
  | "scan-srv2-active-auctions"
  | "scan-tl-active-auctions"
  | "scan-pnd-auction-tokens"
  | "probe-cid-availability"
  | "ponder-drift-check"

export type TaskResult = {
  rpcCalls?: number
  rowsWritten?: number
  scopeCount?: number
}

type Task = {
  name: TaskName
  intervalMs: number
  fn: () => Promise<TaskResult>
  dependsOnPonder?: boolean
}

const MIN = 60_000
const tasks: Task[] = [
  { name: "seed-known-artists",    intervalMs: 60 * MIN, fn: seedKnownArtists },
  { name: "warm-contract-identity",intervalMs: 10 * MIN, fn: warmContractIdentity, dependsOnPonder: true },
  { name: "warm-ens",              intervalMs: 10 * MIN, fn: warmEns,              dependsOnPonder: true },
  { name: "warm-metadata",         intervalMs: 1  * MIN, fn: warmMetadata },
  { name: "scan-fnd-collections",  intervalMs: 10 * MIN, fn: scanFndCollections,   dependsOnPonder: true },
  { name: "scan-fnd-shared",       intervalMs: 10 * MIN, fn: scanFndShared,        dependsOnPonder: true },
  { name: "scan-mint-clones",      intervalMs: 10 * MIN, fn: scanMintClones,       dependsOnPonder: true },
  { name: "scan-tl-clones",        intervalMs: 10 * MIN, fn: scanTlClones,         dependsOnPonder: true },
  { name: "scan-manifold",         intervalMs: 30 * MIN, fn: scanManifold,         dependsOnPonder: true },
  { name: "scan-token-transfers",      intervalMs: 5  * MIN, fn: scanTokenTransfers },
  { name: "scan-1155-stats",           intervalMs: 30 * MIN, fn: scan1155Stats },
  { name: "scan-srv2-active-auctions", intervalMs: 5  * MIN, fn: scanSrv2ActiveAuctions },
  { name: "scan-tl-active-auctions",   intervalMs: 5  * MIN, fn: scanTlActiveAuctions },
  { name: "scan-pnd-auction-tokens",   intervalMs: 15 * MIN, fn: scanPndAuctionTokens, dependsOnPonder: true },
  // Probe public IPFS gateways for known-artists' CIDs. Free public
  // endpoints, separate cost line from Alchemy. 10 min is plenty —
  // pin churn is slow and the table is content-addressed (so once a
  // CID is probed it stays probed for RETRY_AFTER_DAYS).
  { name: "probe-cid-availability",    intervalMs: 10 * MIN, fn: probeCidAvailability },
  { name: "ponder-drift-check",        intervalMs: 60 * MIN, fn: ponderDriftCheck },
]

const runState = new Map<TaskName, { running: boolean; lastRun: Date | null }>()
let lastTickAt: Date | null = null

// Refresh-artist HTTP jobs queue. Single-flight per address.
const refreshQueue = new Set<string>()
const refreshInFlight = new Set<string>()

// Refresh-token HTTP jobs queue. Single-flight per `contract:tokenId`.
const refreshTokenQueue = new Set<string>()
const refreshTokenInFlight = new Set<string>()

export function getLastTickAt(): Date | null {
  return lastTickAt
}

export function getTaskStats(): Record<string, { running: boolean; lastRun: string | null }> {
  const out: Record<string, { running: boolean; lastRun: string | null }> = {}
  for (const [k, v] of runState) {
    out[k] = { running: v.running, lastRun: v.lastRun?.toISOString() ?? null }
  }
  return out
}

export function enqueueRefreshArtist(address: string): boolean {
  const lower = address.toLowerCase()
  if (refreshInFlight.has(lower) || refreshQueue.has(lower)) return false
  refreshQueue.add(lower)
  return true
}

export function enqueueRefreshToken(contract: string, tokenId: string): boolean {
  const key = `${contract.toLowerCase()}:${tokenId}`
  if (refreshTokenInFlight.has(key) || refreshTokenQueue.has(key)) return false
  refreshTokenQueue.add(key)
  return true
}

async function isPonderReady(): Promise<boolean> {
  // Ponder writes is_ready=1 into _ponder_meta once backfill across all
  // chains is complete and it has flipped to head-following mode.
  // Querying this directly avoids a separate indexer-side sentinel.
  const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
    /[^a-zA-Z0-9_]/g, "",
  )
  try {
    const rows = (await sql.unsafe(
      `SELECT value FROM ${schema}._ponder_meta WHERE key = 'app' LIMIT 1`,
    )) as Array<{ value: { is_ready?: number } }>
    return rows[0]?.value?.is_ready === 1
  } catch {
    return false
  }
}

async function runTask(task: Task): Promise<void> {
  const state = runState.get(task.name)
  if (state?.running) return
  if (task.dependsOnPonder && !(await isPonderReady())) {
    // Indexer not ready yet — silently skip, next tick will retry.
    return
  }

  runState.set(task.name, { running: true, lastRun: state?.lastRun ?? null })
  const startedAt = new Date()
  let ok = true
  let error: string | null = null
  let result: TaskResult = {}

  try {
    result = await task.fn()
  } catch (err) {
    ok = false
    error = (err as Error).message
    console.error(`[worker.${task.name}] error:`, err)
  }

  const finishedAt = new Date()
  runState.set(task.name, { running: false, lastRun: finishedAt })
  lastTickAt = finishedAt

  // Audit log; powers /metrics and weekly cost-invariant checks.
  await sql`
    INSERT INTO worker_iterations
      (task, started_at, finished_at, scope_count, rpc_calls, rows_written, ok, error)
    VALUES
      (${task.name}, ${startedAt}, ${finishedAt},
       ${result.scopeCount ?? 0}, ${result.rpcCalls ?? 0},
       ${result.rowsWritten ?? 0}, ${ok}, ${error})
  `.catch((err) => {
    // Don't let an audit write failure mask the task result.
    console.error(`[worker.audit] failed to log ${task.name}:`, err)
  })
}

async function drainRefreshQueue(): Promise<void> {
  if (refreshQueue.size === 0) return
  const next = refreshQueue.values().next().value as string | undefined
  if (!next) return
  refreshQueue.delete(next)
  refreshInFlight.add(next)
  try {
    await refreshArtist(next)
  } catch (err) {
    console.error(`[worker.refresh-artist] ${next}:`, err)
  } finally {
    refreshInFlight.delete(next)
  }
}

async function drainRefreshTokenQueue(): Promise<void> {
  if (refreshTokenQueue.size === 0) return
  const next = refreshTokenQueue.values().next().value as string | undefined
  if (!next) return
  refreshTokenQueue.delete(next)
  refreshTokenInFlight.add(next)
  const sep = next.lastIndexOf(":")
  const contract = next.slice(0, sep)
  const tokenId = next.slice(sep + 1)
  try {
    await refreshToken(contract, tokenId)
  } catch (err) {
    console.error(`[worker.refresh-token] ${next}:`, err)
  } finally {
    refreshTokenInFlight.delete(next)
  }
}

export async function startScheduler(): Promise<void> {
  console.log(`[worker] starting scheduler with ${tasks.length} tasks`)

  // Kick everything once on startup so we don't wait a full interval for
  // the slow tasks. Stagger so we don't fan out concurrent RPC.
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]
    setTimeout(() => void runTask(t), i * 500)
    setInterval(() => void runTask(t), t.intervalMs)
  }

  // Refresh-artist + refresh-token queue workers — drain continuously.
  setInterval(() => void drainRefreshQueue(), 2_000)
  setInterval(() => void drainRefreshTokenQueue(), 2_000)
}
