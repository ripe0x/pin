/**
 * Health + metrics + jobs HTTP surface.
 *
 *   GET  /health                      Railway healthcheck. 200 if loop has
 *                                     ticked within 5× expected idle.
 *   GET  /metrics                     Last 24h of worker_iterations.
 *   POST /jobs/refresh-artist/:address
 *                                     Enqueue immediate per-artist
 *                                     scanning. Dedup'd by the scheduler.
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
  getLastTickAt,
  getQueueStats,
  getTaskStats,
} from "./scheduler.ts"
import { sql } from "./db.ts"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const TOKEN_ID_RE = /^[0-9]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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
  const last = getLastTickAt()
  const since = last ? Date.now() - last.getTime() : Infinity
  const tasks = getTaskStats()
  const overdueTasks = Object.entries(tasks)
    .filter(([, task]) => task.overdue)
    .map(([name]) => name)
  const ok = since < 30 * 60 * 1000 && overdueTasks.length === 0
  res.statusCode = ok ? 200 : 503
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({
    ok,
    lastTickAt: last?.toISOString() ?? null,
    buildSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.COMMIT_REF ?? null,
    indexerSchema: process.env.INDEXER_SCHEMA ?? "indexer_live",
    overdueTasks,
    queues: getQueueStats(),
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
  res.statusCode = 200
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({
    buildSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.COMMIT_REF ?? null,
    indexerSchema: process.env.INDEXER_SCHEMA ?? "indexer_live",
    last24h: rows,
    runtime: stats,
    queues: getQueueStats(),
  }))
}

async function jobsRefreshArtist(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hasValidBearerToken(req)) {
    res.statusCode = 401
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }))
    return
  }

  const url = new URL(req.url ?? "", "http://localhost")
  const address = url.pathname.split("/").pop()!.toLowerCase()
  const jobId = url.searchParams.get("jobId") ?? req.headers["x-pnd-refresh-job"]
  const normalizedJobId = Array.isArray(jobId) ? jobId[0] : jobId
  if (!ADDRESS_RE.test(address) || (normalizedJobId != null && !UUID_RE.test(normalizedJobId))) {
    res.statusCode = 400
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: false, error: "invalid address or job id" }))
    return
  }

  const enqueued = enqueueRefreshArtist(address, normalizedJobId ?? null)
  res.statusCode = 202
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({ ok: true, enqueued, status: "queued" }))
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

  const enqueued = enqueueRefreshToken(contract, tokenId)
  res.statusCode = 202
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({ ok: true, enqueued }))
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
