/**
 * v2 thin shim. The orchestration in v1's external-indexer (refresh
 * loops and batch processing) moves to the worker. Durable queue state and
 * the per-artist cooldown live in the shared `refresh_jobs` table.
 *
 * This module exists so the existing /api/refresh-artist route can keep
 * the same import shape; the implementation now POSTs to the worker.
 */
import "server-only"
import { isKnownArtist } from "./known-artists"

export { isKnownArtist }

export type RefreshReport = {
  ok: boolean
  enqueued: boolean
  status: "queued" | "running"
}

/**
 * Forward the "Refresh my work" button trigger to the worker. The web
 * app does NOT execute the scan itself — the worker is the only place
 * scanners live in v2.
 */
export async function refreshArtist(
  address: string,
  jobId: string,
): Promise<RefreshReport> {
  const workerUrl = process.env.WORKER_URL
  const secret = process.env.WORKER_SECRET ?? process.env.REVALIDATE_SECRET
  if (!workerUrl || !secret) {
    console.error("[refresh-artist] WORKER_URL / WORKER_SECRET unset")
    return { ok: false, enqueued: false, status: "queued" }
  }
  try {
    const res = await fetch(
      `${workerUrl}/jobs/refresh-artist/${address.toLowerCase()}?jobId=${encodeURIComponent(jobId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "X-PND-Refresh-Job": jobId,
        },
      },
    )
    if (!res.ok) return { ok: false, enqueued: false, status: "queued" }
    const body = (await res.json().catch(() => null)) as
      | { enqueued?: boolean; status?: "queued" | "running" }
      | null
    return {
      ok: true,
      enqueued: body?.enqueued !== false,
      status: body?.status === "running" ? "running" : "queued",
    }
  } catch {
    return { ok: false, enqueued: false, status: "queued" }
  }
}

/**
 * Forward a single-token metadata refresh to the worker. The worker
 * re-resolves tokenURI → IPFS/arweave and upserts the `token_metadata` row.
 * Returns whether the worker accepted the job.
 */
export async function refreshTokenMetadata(
  contract: string,
  tokenId: string,
): Promise<{ ok: boolean }> {
  const workerUrl = process.env.WORKER_URL
  const secret = process.env.WORKER_SECRET ?? process.env.REVALIDATE_SECRET
  if (!workerUrl || !secret) {
    console.error("[refresh-token] WORKER_URL / WORKER_SECRET unset")
    return { ok: false }
  }
  try {
    const res = await fetch(
      `${workerUrl}/jobs/refresh-token/${contract.toLowerCase()}/${tokenId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      },
    )
    return { ok: res.ok }
  } catch {
    return { ok: false }
  }
}

/**
 * v1 had a "first scan has never run for this artist" check used by
 * the refresh-button rate limiter. In v2 the rate limit and dedup live
 * in the worker; the web side just enqueues. This always returns false
 * so the route handler doesn't bypass its public rate limit.
 */
export async function hasUnscannedPlatform(_address: string): Promise<boolean> {
  return false
}
