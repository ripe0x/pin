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
      `${workerUrl}/jobs/refresh-artist/${address.toLowerCase()}?secret=${encodeURIComponent(secret)}`,
      { method: "POST" },
    )
    return { caughtUp: res.ok }
  } catch {
    return { caughtUp: false }
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
