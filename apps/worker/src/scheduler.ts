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
import { deriveTokenMedia } from "./tasks/derive-token-media.ts"
import { pruneWorkerIterations } from "./tasks/prune-worker-iterations.ts"
import { syncIndexedOwnership } from "./tasks/sync-indexed-ownership.ts"
import { syncIndexedAttributions } from "./tasks/sync-indexed-attributions.ts"

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
  | "derive-token-media"
  | "prune-worker-iterations"
  | "sync-indexed-ownership"
  | "sync-indexed-attributions"

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
  { name: "sync-indexed-ownership",    intervalMs: 1  * MIN, fn: syncIndexedOwnership, dependsOnPonder: true },
  { name: "sync-indexed-attributions", intervalMs: 5  * MIN, fn: syncIndexedAttributions, dependsOnPonder: true },
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
  // External media derivatives only. Surface capture is the RenderAssets
  // client-side pipeline (#271/#272), so this task explicitly excludes it.
  { name: "derive-token-media", intervalMs: 5 * MIN, fn: deriveTokenMedia, dependsOnPonder: true },
  { name: "prune-worker-iterations", intervalMs: 24 * 60 * MIN, fn: pruneWorkerIterations },
]

type RunState = {
  running: boolean
  lastAttempt: Date | null
  lastSuccess: Date | null
  lastError: string | null
}

const runState = new Map<TaskName, RunState>()
let lastTickAt: Date | null = null
let schedulerStartedAt: Date | null = null

// Refresh-artist HTTP jobs queue. Single-flight per address.
const refreshQueue = new Map<string, string | null>()
const refreshInFlight = new Set<string>()
let refreshDrainRunning = false

// Refresh-token HTTP jobs queue. Single-flight per `contract:tokenId`.
const refreshTokenQueue = new Set<string>()
const refreshTokenInFlight = new Set<string>()

export function getLastTickAt(): Date | null {
  return lastTickAt
}

export function getTaskStats(): Record<string, {
  running: boolean
  intervalMs: number
  lastAttempt: string | null
  lastSuccess: string | null
  lastError: string | null
  overdue: boolean
}> {
  const now = Date.now()
  const out: ReturnType<typeof getTaskStats> = {}
  for (const task of tasks) {
    const state = runState.get(task.name)
    const lastSuccess = state?.lastSuccess?.getTime() ?? 0
    const graceMs = Math.max(10 * MIN, Math.ceil(task.intervalMs * 1.5))
    const withinStartupGrace = schedulerStartedAt
      ? now - schedulerStartedAt.getTime() < graceMs
      : true
    const overdue = Boolean(state?.lastError) || (
      !withinStartupGrace && (
        lastSuccess === 0 || now - lastSuccess > task.intervalMs * 2 + 5 * MIN
      )
    )
    out[task.name] = {
      running: state?.running ?? false,
      intervalMs: task.intervalMs,
      lastAttempt: state?.lastAttempt?.toISOString() ?? null,
      lastSuccess: state?.lastSuccess?.toISOString() ?? null,
      lastError: state?.lastError ?? null,
      overdue,
    }
  }
  return out
}

export function getQueueStats(): Record<string, number> {
  return {
    refreshArtistQueued: refreshQueue.size,
    refreshArtistRunning: refreshInFlight.size,
    refreshTokenQueued: refreshTokenQueue.size,
    refreshTokenRunning: refreshTokenInFlight.size,
  }
}

export function enqueueRefreshArtist(address: string, jobId: string | null = null): boolean {
  const lower = address.toLowerCase()
  if (refreshInFlight.has(lower) || refreshQueue.has(lower)) return false
  refreshQueue.set(lower, jobId)
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
  const schema = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
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

  runState.set(task.name, {
    running: true,
    lastAttempt: state?.lastAttempt ?? null,
    lastSuccess: state?.lastSuccess ?? null,
    lastError: state?.lastError ?? null,
  })
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
  runState.set(task.name, {
    running: false,
    lastAttempt: finishedAt,
    lastSuccess: ok ? finishedAt : (state?.lastSuccess ?? null),
    lastError: ok ? null : error,
  })
  lastTickAt = finishedAt

  // Audit log; powers /metrics and weekly cost-invariant checks.
  await sql`
    INSERT INTO worker_iterations
      (task, started_at, finished_at, scope_count, rpc_calls, rows_written,
       ok, error, build_sha, indexer_schema)
    VALUES
      (${task.name}, ${startedAt}, ${finishedAt},
       ${result.scopeCount ?? 0}, ${result.rpcCalls ?? 0},
       ${result.rowsWritten ?? 0}, ${ok}, ${error},
       ${process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.COMMIT_REF ?? null},
       ${process.env.INDEXER_SCHEMA ?? "indexer_live"})
  `.catch((err) => {
    // Don't let an audit write failure mask the task result.
    console.error(`[worker.audit] failed to log ${task.name}:`, err)
  })
}

async function drainRefreshQueue(): Promise<void> {
  if (refreshDrainRunning) return
  refreshDrainRunning = true
  try {
    const queued = refreshQueue.entries().next().value as
      | [string, string | null]
      | undefined
    if (queued) refreshQueue.delete(queued[0])
    const requestedJobId = queued?.[1] ?? null
    const claimAnyDurableJob = !queued
    const claimed = (await sql`
      WITH candidate AS (
        SELECT id, artist
        FROM refresh_jobs
        WHERE (${claimAnyDurableJob} OR id = ${requestedJobId}::uuid)
          AND (
            status = 'queued'
            OR (status = 'running' AND lease_expires_at < NOW())
          )
        ORDER BY requested_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE refresh_jobs j SET
        status = 'running',
        started_at = COALESCE(j.started_at, NOW()),
        heartbeat_at = NOW(),
        lease_expires_at = NOW() + INTERVAL '10 minutes',
        attempts = j.attempts + 1,
        updated_at = NOW(),
        error = NULL
      FROM candidate c
      WHERE j.id = c.id
      RETURNING j.id::text AS id, j.artist
    `) as Array<{ id: string; artist: string }>
    const job = claimed[0]
    // If a caller named a durable job but another worker claimed or completed
    // it, do not silently downgrade it to an untracked in-memory refresh.
    if (requestedJobId && !job) return
    const address = job?.artist ?? queued?.[0]
    if (!address) return

    refreshInFlight.add(address)
    const heartbeat = job
      ? setInterval(() => {
          void sql`
            UPDATE refresh_jobs SET heartbeat_at = NOW(),
              lease_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW()
            WHERE id = ${job.id}::uuid AND status = 'running'
          `.catch((error) => {
            console.error(`[worker.refresh-artist] heartbeat ${job.id}:`, error)
          })
        }, 30_000)
      : null
    try {
      const report = await refreshArtist(address)
      if (job) {
        const error = report.status === "failed"
          ? Object.values(report.sources)
              .map((source) => source.error)
              .filter(Boolean)
              .join("; ")
          : null
        await sql`
          UPDATE refresh_jobs SET
            status = ${report.status},
            result = ${sql.json(report)},
            error = ${error || null},
            finished_at = NOW(),
            heartbeat_at = NOW(),
            lease_expires_at = NULL,
            updated_at = NOW()
          WHERE id = ${job.id}::uuid AND status = 'running'
        `
      }
    } catch (err) {
      console.error(`[worker.refresh-artist] ${address}:`, err)
      if (job) {
        await sql`
          UPDATE refresh_jobs SET status = 'failed', error = ${String(err)},
            finished_at = NOW(), heartbeat_at = NOW(), lease_expires_at = NULL,
            updated_at = NOW()
          WHERE id = ${job.id}::uuid AND status = 'running'
        `.catch((updateError) => {
          console.error(`[worker.refresh-artist] fail job ${job.id}:`, updateError)
        })
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      refreshInFlight.delete(address)
    }
  } finally {
    // A failed claim must not wedge refresh draining until process restart.
    refreshDrainRunning = false
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
  schedulerStartedAt = new Date()

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
