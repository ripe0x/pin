/**
 * Per-IP token-bucket rate limiter for API routes.
 *
 * Originally inlined in `/api/rpc/route.ts`; extracted here so the
 * `/api/meta` and `/api/artist/.../tokens` routes — which both fan out
 * to expensive backend work (RPC reads, multicalls) — can apply the
 * same protection without re-implementing it.
 *
 * Storage: in-process Map per Node sandbox, persisted across HMR via
 * `globalThis`. On Vercel/Netlify each function instance has its own
 * counter, so a determined attacker rotating regions can buy themselves
 * a multiplier — but unbounded scraping is still blocked.
 *
 * NOT for cryptographic / billing-grade rate limiting. The goal is
 * "stop a single IP from amplifying its blast radius into the backend
 * by orders of magnitude." For tighter control, swap in a shared
 * KV/Redis bucket later.
 */
import type { NextRequest } from "next/server"

type Counter = { count: number; windowStart: number }

type Bucket = {
  windowMs: number
  maxPerWindow: number
  counts: Map<string, Counter>
}

// Per-bucket Maps keyed by namespace string. Buckets are created lazily
// on first use of a namespace. Persist across HMR.
const buckets: Map<string, Bucket> =
  (globalThis as unknown as { __pndRateLimitBuckets?: Map<string, Bucket> })
    .__pndRateLimitBuckets ??
  ((globalThis as unknown as { __pndRateLimitBuckets?: Map<string, Bucket> }).__pndRateLimitBuckets = new Map())

function getBucket(namespace: string, windowMs: number, maxPerWindow: number): Bucket {
  let b = buckets.get(namespace)
  if (!b) {
    b = { windowMs, maxPerWindow, counts: new Map() }
    buckets.set(namespace, b)
  }
  return b
}

export function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return req.headers.get("x-real-ip") ?? "unknown"
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number }

/**
 * Check whether `ip` may make another request under the named bucket's
 * budget. Increments the counter on success.
 *
 * Buckets are independent per `namespace` — `/api/rpc` and `/api/meta`
 * each have their own counter for the same IP, so heavy use of one
 * doesn't squeeze out the other.
 */
export function checkRateLimit(
  namespace: string,
  ip: string,
  windowMs: number,
  maxPerWindow: number,
): RateLimitResult {
  const bucket = getBucket(namespace, windowMs, maxPerWindow)
  const now = Date.now()

  // Opportunistic cleanup so the map doesn't grow without bound.
  if (bucket.counts.size > 5000) {
    for (const [k, c] of bucket.counts) {
      if (now - c.windowStart > bucket.windowMs) bucket.counts.delete(k)
    }
  }

  const c = bucket.counts.get(ip)
  if (!c || now - c.windowStart > bucket.windowMs) {
    bucket.counts.set(ip, { count: 1, windowStart: now })
    return { ok: true }
  }
  if (c.count >= bucket.maxPerWindow) {
    const retryAfter = Math.ceil(
      (bucket.windowMs - (now - c.windowStart)) / 1000,
    )
    return { ok: false, retryAfter }
  }
  c.count++
  return { ok: true }
}
