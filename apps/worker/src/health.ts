/**
 * Health + metrics + jobs HTTP surface.
 *
 *   GET  /health                      Railway healthcheck + alerting. 200
 *                                     only if every scheduled task is
 *                                     healthy (task-health.ts): not N
 *                                     consecutive failed runs (default 3,
 *                                     HEALTH_MAX_CONSECUTIVE_FAILURES), not
 *                                     running past its timeout, and run
 *                                     within 3x its interval. 503 with the
 *                                     per-task report otherwise.
 *   GET  /metrics                     Last 24h of worker_iterations, plus
 *                                     scan_backoff / transfer backfill
 *                                     queue summaries.
 *   POST /jobs/refresh-artist/:address
 *   POST /jobs/refresh-token/:contract/:tokenId
 *                                     LEGACY. Insert a durable job into
 *                                     refresh_jobs (refresh-queue.ts). The
 *                                     web now inserts directly (#297); this
 *                                     stays so a web deploy older than the
 *                                     queue keeps working during rollout.
 *                                     Remove once web no longer calls it.
 *
 * No auth on /health and /metrics (Railway-internal). The /jobs endpoint
 * checks a bearer token so the web app can forward the existing "Refresh my
 * work" button calls without leaking the shared secret into request URLs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import {
  enqueueRefreshArtist,
  enqueueRefreshToken,
  getBootAt,
  getLastTickAt,
  getTaskHealthInputs,
  getTaskStats,
} from "./scheduler.ts"
import { sql } from "./db.ts"
import { evaluateHealth, maxConsecutiveFailures } from "./task-health.ts"
import { QUEUE_STATS_SQL } from "./refresh-queue.ts"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const TOKEN_ID_RE = /^[0-9]+$/
const SECRET = process.env.WORKER_SECRET ?? process.env.REVALIDATE_SECRET ?? ""

export async function startHealthServer(port: number): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/health") return health(res)
      if (req.url === "/metrics") return metrics(res)
      if (req.method === "POST" && req.url?.startsWith("/jobs/refresh-artist/")) {
        return jobsRefreshArtist(req, res)
      }
      if (req.method === "POST" && req.url?.startsWith("/jobs/refresh-token/")) {
        return jobsRefreshToken(req, res)
      }
      res.statusCode = 404
      res.end()
    } catch (err) {
      console.error("[worker.http] error:", err)
      res.statusCode = 500
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: false }))
    }
  })

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(`[worker] health server listening on :${port}`)
      resolve()
    })
  })
}

function health(res: ServerResponse): void {
  // In-memory only (no DB round trip), so the check itself can't hang.
  const now = new Date()
  const report = evaluateHealth(getTaskHealthInputs(), now, getBootAt(), {
    maxConsecutiveFailures: maxConsecutiveFailures(process.env.HEALTH_MAX_CONSECUTIVE_FAILURES),
  })
  res.statusCode = report.ok ? 200 : 503
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({
    ok: report.ok,
    unhealthy: report.unhealthy,
    lastTickAt: getLastTickAt()?.toISOString() ?? null,
    bootAt: getBootAt().toISOString(),
    tasks: report.tasks,
  }))
}

async function metrics(res: ServerResponse): Promise<void> {
  const rows = await sql`
    SELECT task,
           count(*)                                  AS iterations,
           count(*) FILTER (WHERE NOT ok)            AS errors,
           sum(rpc_calls)                            AS rpc_calls,
           sum(rows_written)                         AS rows_written,
           max(finished_at)                          AS last_finished_at
    FROM worker_iterations
    WHERE started_at > NOW() - INTERVAL '24 hours'
    GROUP BY task
    ORDER BY task
  `
  const stats = getTaskStats()
  // Scopes currently backed off (backoff.ts) and backfill debt
  // (transfer-backfill.ts). Best effort: tables absent before 030/031.
  const backoff = await sql`
    SELECT task,
           count(*)                                  AS scopes,
           count(*) FILTER (WHERE retry_at > NOW())  AS waiting,
           max(failures)                             AS max_failures
    FROM scan_backoff GROUP BY task ORDER BY task
  `.catch(() => null)
  const backfill = await sql`
    SELECT count(*)                  AS tokens,
           count(DISTINCT contract)  AS contracts,
           count(*) FILTER (WHERE failures > 0) AS failing,
           min(enqueued_at)          AS oldest
    FROM transfer_backfill_queue
  `.catch(() => null)
  // Durable refresh queue (migration 035); null before it's applied.
  const refreshJobs = await sql.unsafe(QUEUE_STATS_SQL).catch(() => null)
  res.statusCode = 200
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({
    last24h: rows,
    runtime: stats,
    backoff,
    transferBackfill: backfill?.[0] ?? null,
    refreshJobs,
  }))
}

async function jobsRefreshArtist(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hasValidBearerToken(req)) {
    res.statusCode = 401
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }))
    return
  }

  const address = req.url!.split("/").pop()!.split("?")[0].toLowerCase()
  if (!ADDRESS_RE.test(address)) {
    res.statusCode = 400
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: false, error: "invalid address" }))
    return
  }

  const enqueued = await enqueueRefreshArtist(address).catch((err) => {
    console.error("[worker.http] enqueue refresh-artist:", err)
    return null
  })
  if (enqueued === null) return queueUnavailable(res)
  res.statusCode = 202
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({ ok: true, enqueued }))
}

async function jobsRefreshToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost")
  if (!hasValidBearerToken(req)) {
    res.statusCode = 401
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }))
    return
  }

  // Path: /jobs/refresh-token/<contract>/<tokenId>
  const parts = url.pathname.split("/").filter(Boolean) // ["jobs","refresh-token",contract,tokenId]
  const contract = (parts[2] ?? "").toLowerCase()
  const tokenId = parts[3] ?? ""
  if (!ADDRESS_RE.test(contract) || !TOKEN_ID_RE.test(tokenId)) {
    res.statusCode = 400
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: false, error: "invalid contract or tokenId" }))
    return
  }

  const enqueued = await enqueueRefreshToken(contract, tokenId).catch((err) => {
    console.error("[worker.http] enqueue refresh-token:", err)
    return null
  })
  if (enqueued === null) return queueUnavailable(res)
  res.statusCode = 202
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({ ok: true, enqueued }))
}

function queueUnavailable(res: ServerResponse): void {
  res.statusCode = 503
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({ ok: false, error: "refresh queue unavailable" }))
}

function hasValidBearerToken(req: IncomingMessage): boolean {
  const authorization = req.headers.authorization
  if (!SECRET || !authorization?.startsWith("Bearer ")) return false
  const provided = authorization.slice("Bearer ".length)
  const expectedBytes = Buffer.from(SECRET)
  const providedBytes = Buffer.from(provided)
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  )
}
