/**
 * Pure parts of the API rate limiter: client-IP keying, the per-instance
 * in-memory window, and the shared (Postgres-backed) window's decision logic
 * with its storage injected. `rate-limit.ts` wires these to the real request
 * and database; tests exercise them directly.
 */

/** Minimal header surface, so this works with Request, NextRequest, or a
 *  plain Headers object in tests. */
export type HeaderSource = { headers: { get(name: string): string | null } }

/**
 * The client IP to key a limit on.
 *
 * Order: `x-nf-client-connection-ip` (set by Netlify's edge from the TCP
 * connection, and not passed through from the client), then `x-real-ip`,
 * then the first `x-forwarded-for` entry. The XFF value is client-supplied on
 * most hosts, so it is the last resort rather than the first choice.
 */
export function getClientIp(req: HeaderSource): string {
  const nf = req.headers.get("x-nf-client-connection-ip")?.trim()
  if (nf) return nf
  const real = req.headers.get("x-real-ip")?.trim()
  if (real) return real
  const xff = req.headers.get("x-forwarded-for")
  if (xff) {
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  return "unknown"
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number }

type Counter = { count: number; windowStart: number }

export type MemoryLimiter = {
  check(key: string, windowMs: number, maxPerWindow: number, cost?: number, now?: number): RateLimitResult
}

/** Fixed-window counter held in process memory. One per namespace. */
export function createMemoryLimiter(maxKeys = 5000): MemoryLimiter {
  const counts = new Map<string, Counter>()
  return {
    check(key, windowMs, maxPerWindow, cost = 1, now = Date.now()) {
      // Opportunistic cleanup so the map does not grow without bound.
      if (counts.size > maxKeys) {
        for (const [k, c] of counts) {
          if (now - c.windowStart > windowMs) counts.delete(k)
        }
      }
      const c = counts.get(key)
      if (!c || now - c.windowStart > windowMs) {
        if (cost > maxPerWindow) {
          return { ok: false, retryAfter: Math.ceil(windowMs / 1000) }
        }
        counts.set(key, { count: cost, windowStart: now })
        return { ok: true }
      }
      if (c.count + cost > maxPerWindow) {
        return {
          ok: false,
          retryAfter: Math.max(1, Math.ceil((windowMs - (now - c.windowStart)) / 1000)),
        }
      }
      c.count += cost
      return { ok: true }
    },
  }
}

/** Storage for the shared window: atomically add `cost` to `key`'s counter,
 *  starting a fresh window when the stored one is older than `windowMs`,
 *  and return the counter after the increment. */
export type SharedCounterStore = (
  key: string,
  windowMs: number,
  cost: number,
) => Promise<{ count: number; windowStart: Date } | null>

/**
 * Shared-window decision. Fails open: a store error, a timeout, or a missing
 * store allows the request, since the in-memory limiter has already run as
 * the first line and an unavailable database must not take the API down.
 */
export async function checkSharedLimit(
  store: SharedCounterStore | null,
  key: string,
  windowMs: number,
  maxPerWindow: number,
  cost = 1,
  opts: { timeoutMs?: number; now?: number } = {},
): Promise<RateLimitResult> {
  if (!store) return { ok: true }
  const timeoutMs = opts.timeoutMs ?? 750
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const row = await Promise.race([
      store(key, windowMs, cost),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
    if (!row) return { ok: true }
    if (row.count <= maxPerWindow) return { ok: true }
    const now = opts.now ?? Date.now()
    const elapsed = now - row.windowStart.getTime()
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)) }
  } catch {
    return { ok: true }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
