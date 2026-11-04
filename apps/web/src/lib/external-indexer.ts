/**
 * LEGACY rollout fallback. The refresh routes now enqueue durable jobs
 * straight into Postgres (`refresh_jobs`, lib/refresh-jobs.ts, #297) and
 * never call the worker. These POSTs to the worker's /jobs endpoints are
 * only used when migration 035 hasn't been applied yet (the routes see
 * undefined_table); delete this module once 035 is applied everywhere.
 */
import "server-only"
import { isKnownArtist } from "./known-artists"

export { isKnownArtist }

export type RefreshReport = {
  caughtUp: boolean
}

/**
 * Forward the "Refresh my work" button trigger to the worker. The web
 * app does NOT execute the scan itself — the worker is the only place
 * scanners live in v2.
 */
export async function refreshArtist(address: string): Promise<RefreshReport> {
  const workerUrl = process.env.WORKER_URL
  const secret = process.env.WORKER_SECRET ?? process.env.REVALIDATE_SECRET
  if (!workerUrl || !secret) {
    console.error("[refresh-artist] WORKER_URL / WORKER_SECRET unset")
    return { caughtUp: false }
  }
  try {
    const res = await fetch(
      `${workerUrl}/jobs/refresh-artist/${address.toLowerCase()}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      },
    )
    return { caughtUp: res.ok }
  } catch {
    return { caughtUp: false }
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
