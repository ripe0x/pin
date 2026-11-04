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
import { INDEXER_SCHEMA } from "./indexer-schema.ts"
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
import { captureCollectionMedia } from "./tasks/capture-collection-media.ts"
import { deriveTokenMedia } from "./tasks/derive-token-media.ts"
import { pruneRetention } from "./tasks/prune-retention.ts"
import { defaultTaskTimeoutMs, type TaskHealthInput } from "./task-health.ts"
import {
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_LEASE_SECONDS,
  artistTarget,
  claimRefreshJob,
  enqueueRefreshJob,
  parseTokenTarget,
  positiveIntEnv,
  reclaimExpiredJobs,
  releaseRefreshJob,
  runClaimedRefreshJob,
  tokenTarget,
  type ClaimedJob,
  type RefreshJobKind,
} from "./refresh-queue.ts"

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
  | "capture-collection-media"
  | "derive-token-media"
  | "prune-retention"

export type TaskResult = {
  rpcCalls?: number
  rowsWritten?: number
  scopeCount?: number
  /**
   * Per-scope failures a task survived (it kept going for other scopes)
   * but must not hide. Non-empty marks the iteration `ok = false` in
   * worker_iterations while still recording the counts, so a scanner that
   * stopped short on an RPC error shows up as failed instead of as a
   * quiet success.
   */
  errors?: string[]
}

// worker_iterations.error is TEXT; keep one bad tick from writing a
// megabyte of repeated stack text.
const MAX_ERROR_CHARS = 4_000

export function summarizeTaskErrors(errors: string[]): string {
  const head = errors.length === 1 ? "" : `${errors.length} errors: `
  const joined = head + errors.join(" | ")
  return joined.length > MAX_ERROR_CHARS
    ? `${joined.slice(0, MAX_ERROR_CHARS - 1)}…`
    : joined
}

type Task = {
  name: TaskName
  intervalMs: number
  fn: () => Promise<TaskResult>
  dependsOnPonder?: boolean
  /**
   * A run longer than this makes /health report the task as stuck.
   * Defaults to 6x the interval, at least 2 hours (task-health.ts).
   */
  timeoutMs?: number
}

const MIN = 60_000
const tasks: Task[] = [
  { name: "seed-known-artists",    intervalMs: 60 * MIN, fn: seedKnownArtists },
  { name: "warm-contract-identity",intervalMs: 10 * MIN, fn: warmContractIdentity, dependsOnPonder: true },
  { name: "warm-ens",              intervalMs: 10 * MIN, fn: warmEns,              dependsOnPonder: true },
  { name: "warm-metadata",         intervalMs: 5  * MIN, fn: warmMetadata },
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
  // PND Surface System media capture (SVG rasterize only, v1). The task
  // reads Ponder's collections/collection_tokens tables and keeps its own
  // schema/deploy gates; scheduler gating avoids starting it before Ponder
  // is ready. Generous interval: capture is not time-sensitive, and each
  // run is bounded by CAPTURE_BATCH_SIZE.
  { name: "capture-collection-media", intervalMs: 10 * MIN, fn: captureCollectionMedia, dependsOnPonder: true },
  { name: "derive-token-media", intervalMs: 5 * MIN, fn: deriveTokenMedia, dependsOnPonder: true },
  // Retention for the shared DB: expired cache_entries, old
  // worker_iterations, stale rate_limits / scan_backoff (#351 phase 0).
  // Pure SQL, bounded batches; no RPC.
  { name: "prune-retention", intervalMs: 60 * MIN, fn: pruneRetention },
]

type RunState = {
  running: boolean
  runningSince: Date | null
  /** Last time a run finished (ok or not). */
  lastRun: Date | null
  lastOkAt: Date | null
  /** Last time a run was skipped because Ponder wasn't ready. */
  lastSkippedAt: Date | null
  consecutiveFailures: number
  lastError: string | null
}

const runState = new Map<TaskName, RunState>()
let lastTickAt: Date | null = null
const bootAt = new Date()

function stateOf(name: TaskName): RunState {
  return runState.get(name) ?? {
    running: false,
    runningSince: null,
    lastRun: null,
    lastOkAt: null,
    lastSkippedAt: null,
    consecutiveFailures: 0,
    lastError: null,
  }
}

// On-demand refreshes run from the durable `refresh_jobs` queue
// (refresh-queue.ts, migration 035). Jobs this process currently holds,
// so a graceful shutdown can hand them back without spending an attempt.
const heldJobs = new Map<string, ClaimedJob>()
const REFRESH_CONCURRENCY: Record<RefreshJobKind, number> = {
  artist: positiveIntEnv(process.env.REFRESH_ARTIST_CONCURRENCY, 2),
  token: positiveIntEnv(process.env.REFRESH_TOKEN_CONCURRENCY, 4),
}
const REFRESH_TIMEOUT_MS: Record<RefreshJobKind, number> = {
  artist: positiveIntEnv(process.env.REFRESH_ARTIST_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS.artist),
  token: positiveIntEnv(process.env.REFRESH_TOKEN_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS.token),
}
// How often each kind polls for due jobs: one indexed UPDATE per poll
// (refresh_jobs_claim_idx), a few seconds of pickup latency.
const REFRESH_POLL_MS = positiveIntEnv(process.env.REFRESH_POLL_MS, 3_000)
const REFRESH_LEASE_SECONDS = positiveIntEnv(
  process.env.REFRESH_JOB_LEASE_SECONDS,
  DEFAULT_LEASE_SECONDS,
)
const refreshHandlers: Record<RefreshJobKind, (target: string) => Promise<unknown>> = {
  artist: (target) => refreshArtist(target),
  token: async (target) => {
    const { contract, tokenId } = parseTokenTarget(target)
    return { outcome: await refreshToken(contract, tokenId) }
  },
}
const refreshInFlight: Record<RefreshJobKind, number> = { artist: 0, token: 0 }
const refreshPumping: Record<RefreshJobKind, boolean> = { artist: false, token: false }
let refreshQueueErrorAt = 0

export function getLastTickAt(): Date | null {
  return lastTickAt
}

export function getBootAt(): Date {
  return bootAt
}

export function getTaskStats(): Record<string, { running: boolean; lastRun: string | null }> {
  const out: Record<string, { running: boolean; lastRun: string | null }> = {}
  for (const [k, v] of runState) {
    out[k] = { running: v.running, lastRun: v.lastRun?.toISOString() ?? null }
  }
  return out
}

/** Per-task inputs for /health (task-health.ts evaluates them). */
export function getTaskHealthInputs(): TaskHealthInput[] {
  return tasks.map((t) => {
    const st = stateOf(t.name)
    return {
      name: t.name,
      intervalMs: t.intervalMs,
      timeoutMs: t.timeoutMs ?? defaultTaskTimeoutMs(t.intervalMs),
      running: st.running,
      runningSince: st.runningSince,
      lastFinishedAt: st.lastRun,
      lastOkAt: st.lastOkAt,
      lastSkippedAt: st.lastSkippedAt,
      consecutiveFailures: st.consecutiveFailures,
      lastError: st.lastError,
    }
  })
}

/**
 * Enqueue a durable artist refresh. False when the address is invalid or
 * a job for it is already queued or running.
 */
export async function enqueueRefreshArtist(address: string): Promise<boolean> {
  const target = artistTarget(address)
  return target ? enqueueRefreshJob(sql, "artist", target) : false
}

export async function enqueueRefreshToken(contract: string, tokenId: string): Promise<boolean> {
  const target = tokenTarget(contract, tokenId)
  return target ? enqueueRefreshJob(sql, "token", target) : false
}

let ponderReadyCached = false

async function isPonderReady(): Promise<boolean> {
  if (ponderReadyCached) return true
  try {
    const rows = (await sql.unsafe(
      `SELECT value FROM ${INDEXER_SCHEMA}._ponder_meta WHERE key = 'app' LIMIT 1`,
    )) as Array<{ value: { is_ready?: number } }>
    const ready = rows[0]?.value?.is_ready === 1
    if (ready) ponderReadyCached = true
    return ready
  } catch {
    return false
  }
}

async function runTask(task: Task): Promise<void> {
  const state = stateOf(task.name)
  if (state.running) return
  if (task.dependsOnPonder && !(await isPonderReady())) {
    // Indexer not ready yet — skip, next tick will retry. Recorded so
    // /health can tell "waiting on Ponder" from "never runs".
    runState.set(task.name, { ...stateOf(task.name), lastSkippedAt: new Date() })
    return
  }

  runState.set(task.name, { ...state, running: true, runningSince: new Date() })
  const startedAt = new Date()
  let ok = true
  let error: string | null = null
  let result: TaskResult = {}

  try {
    result = await task.fn()
    if (result.errors && result.errors.length > 0) {
      ok = false
      error = summarizeTaskErrors(result.errors)
      console.error(`[worker.${task.name}] finished with errors: ${error}`)
    }
  } catch (err) {
    ok = false
    error = (err as Error).message
    console.error(`[worker.${task.name}] error:`, err)
  }

  const finishedAt = new Date()
  const prev = stateOf(task.name)
  runState.set(task.name, {
    ...prev,
    running: false,
    runningSince: null,
    lastRun: finishedAt,
    lastOkAt: ok ? finishedAt : prev.lastOkAt,
    consecutiveFailures: ok ? 0 : prev.consecutiveFailures + 1,
    lastError: ok ? prev.lastError : error,
  })
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
    console.error(`[worker.audit] failed to log ${task.name}:`, err)
  })
}

function logRefreshQueueError(err: unknown): void {
  // Throttled: before migration 035 is applied every poll fails the same
  // way, and the poll runs every 2s.
  const now = Date.now()
  if (now - refreshQueueErrorAt < 5 * 60_000) return
  refreshQueueErrorAt = now
  console.error("[worker.refresh-queue] poll failed (is migration 035 applied?):", err)
}

/**
 * Claim and start due jobs of `kind` up to its concurrency. Each job
 * runs detached; the next poll tops the slots back up.
 */
async function pumpRefreshJobs(kind: RefreshJobKind): Promise<void> {
  if (refreshPumping[kind]) return
  refreshPumping[kind] = true
  try {
    while (refreshInFlight[kind] < REFRESH_CONCURRENCY[kind]) {
      const job = await claimRefreshJob(sql, kind)
      if (!job) break
      refreshInFlight[kind]++
      heldJobs.set(job.id, job)
      console.log(`[worker.refresh-${kind}] job ${job.id} ${job.target} attempt ${job.attempts}/${job.maxAttempts}`)
      void runClaimedRefreshJob(sql, job, refreshHandlers[kind], {
        timeoutMs: REFRESH_TIMEOUT_MS[kind],
      })
        .then((out) => {
          if (out.kind === "done") {
            console.log(`[worker.refresh-${kind}] job ${job.id} done`, JSON.stringify(out.result))
          } else if (out.kind === "lost") {
            console.warn(`[worker.refresh-${kind}] job ${job.id} lease was reclaimed mid-run`)
          } else {
            console.error(`[worker.refresh-${kind}] job ${job.id} ${out.kind}: ${out.error}`)
          }
        })
        .catch((err) => console.error(`[worker.refresh-${kind}] job ${job.id}:`, err))
        .finally(() => {
          refreshInFlight[kind]--
          heldJobs.delete(job.id)
        })
    }
  } catch (err) {
    logRefreshQueueError(err)
  } finally {
    refreshPumping[kind] = false
  }
}

async function reclaimRefreshJobs(): Promise<void> {
  try {
    const rows = await reclaimExpiredJobs(sql, REFRESH_LEASE_SECONDS)
    if (rows.length > 0) {
      console.warn(`[worker.refresh-queue] reclaimed ${rows.length} job(s) with an expired lease: ${rows.map((r) => `${r.id}->${r.status}`).join(", ")}`)
    }
  } catch (err) {
    logRefreshQueueError(err)
  }
}

/**
 * Graceful shutdown: put the jobs this process is running back in the
 * queue without spending an attempt, so the next worker picks them up
 * right away instead of after the lease expires.
 */
export async function releaseHeldRefreshJobs(): Promise<void> {
  const jobs = Array.from(heldJobs.values())
  await Promise.allSettled(jobs.map((j) => releaseRefreshJob(sql, j)))
  if (jobs.length > 0) console.log(`[worker.refresh-queue] released ${jobs.length} running job(s)`)
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

  // Durable refresh queue (refresh_jobs): poll for due jobs, and reclaim
  // jobs a crashed or restarted worker left 'running'. Reclaim once at
  // boot too, so a crash's jobs return after at most one lease.
  void reclaimRefreshJobs()
  setInterval(() => void pumpRefreshJobs("artist"), REFRESH_POLL_MS)
  setInterval(() => void pumpRefreshJobs("token"), REFRESH_POLL_MS)
  setInterval(() => void reclaimRefreshJobs(), 60_000)
}
