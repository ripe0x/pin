/**
 * Per-IP rate limiting for API routes.
 *
 * Two layers, checked in order:
 *
 *   1. In-process fixed window (per Node sandbox, persisted across HMR via
 *      `globalThis`). Free, and catches a single client hammering one warm
 *      instance without a database round trip.
 *   2. Shared fixed window in Postgres (`rate_limits`, migration 028), one
 *      atomic upsert-increment per request. Serverless hosts run many
 *      instances, each with its own memory, so this is the layer that holds
 *      a budget across the fleet. Fails open: if the table is missing or the
 *      database is slow or down, the request is allowed (layer 1 still ran).
 *
 * Keys are a salted `sha256(namespace:ip)`, so raw client IPs are never stored. The
 * client IP comes from `getClientIp` (see rate-limit-core.ts for the header
 * order).
 *
 * The goal is to stop one client from amplifying into the backend by orders
 * of magnitude, not billing-grade accounting.
 */
import "server-only"
import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { sql } from "./db"
import {
  checkSharedLimit,
  createMemoryLimiter,
  getClientIp,
  type HeaderSource,
  type MemoryLimiter,
  type RateLimitResult,
  type SharedCounterStore,
} from "./rate-limit-core"

export { getClientIp, type RateLimitResult }

const limiters: Map<string, MemoryLimiter> =
  (globalThis as unknown as { __pndRateLimiters?: Map<string, MemoryLimiter> })
    .__pndRateLimiters ??
  ((globalThis as unknown as { __pndRateLimiters?: Map<string, MemoryLimiter> }).__pndRateLimiters =
    new Map())

function memoryLimiter(namespace: string): MemoryLimiter {
  let l = limiters.get(namespace)
  if (!l) {
    l = createMemoryLimiter()
    limiters.set(namespace, l)
  }
  return l
}

/** Rows older than this are deleted opportunistically (about 1 call in 200). */
const PRUNE_PROBABILITY = 1 / 200

const pgStore: SharedCounterStore | null = sql
  ? async (key, windowMs, cost) => {
      const db = sql!
      const rows = await db<{ count: number; window_start: Date }[]>`
        INSERT INTO rate_limits (key, window_start, count)
        VALUES (${key}, now(), ${cost})
        ON CONFLICT (key) DO UPDATE SET
          count = CASE
            WHEN rate_limits.window_start <= now() - (${windowMs}::int * interval '1 millisecond')
              THEN EXCLUDED.count
            ELSE rate_limits.count + EXCLUDED.count
          END,
          window_start = CASE
            WHEN rate_limits.window_start <= now() - (${windowMs}::int * interval '1 millisecond')
              THEN now()
            ELSE rate_limits.window_start
          END
        RETURNING count, window_start
      `
      if (Math.random() < PRUNE_PROBABILITY) {
        void db`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`.catch(
          () => {},
        )
      }
      const row = rows[0]
      return row ? { count: Number(row.count), windowStart: new Date(row.window_start) } : null
    }
  : null

// Optional salt (shared with the RPC log's IP hashing) so stored keys can't
// be matched back to IPs by hashing the address space.
const KEY_SALT = process.env.RATE_LIMIT_SALT ?? process.env.RPC_LOG_SALT ?? ""

function sharedKey(namespace: string, ip: string): string {
  return createHash("sha256").update(`${KEY_SALT}:${namespace}:${ip}`).digest("hex").slice(0, 40)
}

export type RateLimitOptions = {
  /** Independent budget per namespace: heavy use of one route does not
   *  squeeze out another for the same client. */
  namespace: string
  windowMs: number
  max: number
  /** Units this request consumes (a JSON-RPC batch charges per entry). */
  cost?: number
  /** Skip the shared Postgres layer (memory only). */
  memoryOnly?: boolean
}

/** Check (and consume) budget for the client behind `req`. */
export async function rateLimit(
  req: HeaderSource,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const ip = getClientIp(req)
  const cost = opts.cost ?? 1
  const mem = memoryLimiter(opts.namespace).check(ip, opts.windowMs, opts.max, cost)
  if (!mem.ok) return mem
  if (opts.memoryOnly) return mem
  return checkSharedLimit(pgStore, sharedKey(opts.namespace, ip), opts.windowMs, opts.max, cost)
}

/** `rateLimit`, mapped to a ready 429 response (or null when allowed). */
export async function rateLimitResponse(
  req: HeaderSource,
  opts: RateLimitOptions,
): Promise<NextResponse | null> {
  const rl = await rateLimit(req, opts)
  if (rl.ok) return null
  return NextResponse.json(
    { ok: false, error: "rate-limited", retryAfter: rl.retryAfter },
    { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
  )
}
