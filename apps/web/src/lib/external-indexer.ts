/**
 * v2 thin shim. The orchestration in v1's external-indexer (refresh
 * loops, batch processing, per-artist cooldowns) moves to the worker
 * (apps/worker/src/scheduler.ts + tasks/refresh-artist.ts).
 *
 * This module exists so the existing /api/refresh-artist route can keep
 * the same import shape; the implementation now POSTs to the worker.
 */
import "server-only"
import { isKnownArtist } from "./known-artists"

export { isKnownArtist }

export type RefreshReport = {
  caughtUp: boolean
}

let warnedSecretFallback = false

/**
 * The bearer secret for worker job calls. `WORKER_SECRET` is the intended
 * variable; `REVALIDATE_SECRET` is still accepted because the worker reads
 * the same fallback (apps/worker/src/health.ts) and deployed environments
 * may only set that one. Using the fallback logs a warning once per
 * instance so the two secrets can be split deliberately.
 */
function workerSecret(): string | undefined {
  const dedicated = process.env.WORKER_SECRET
  if (dedicated) return dedicated
  const fallback = process.env.REVALIDATE_SECRET
  if (fallback && !warnedSecretFallback) {
    warnedSecretFallback = true
    console.warn(
      "[worker] WORKER_SECRET is unset; using REVALIDATE_SECRET for worker job auth. Set a dedicated WORKER_SECRET on web and worker.",
    )
  }
  return fallback
}

/**
 * Forward the "Refresh my work" button trigger to the worker. The web
 * app does NOT execute the scan itself — the worker is the only place
 * scanners live in v2.
 */
export async function refreshArtist(address: string): Promise<RefreshReport> {
  const workerUrl = process.env.WORKER_URL
  const secret = workerSecret()
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
  const secret = workerSecret()
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
