import "server-only"
import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { http, type HttpTransportConfig, type Transport } from "viem"
import { sql } from "./db"

/**
 * Sampled RPC call logger backed by the `rpc_events` Postgres table.
 *
 * Two callers:
 *   - `/api/rpc` proxy logs each browser-originated RPC with the calling
 *     page's pathname as `referer`, so we can see which page drives the
 *     most calls.
 *   - Server-side fanouts (Alchemy enhanced API in `alchemy.ts`, viem
 *     clients in `alchemy-rpc.ts`) log each upstream call with `route`
 *     set to the API handler that initiated the work, so we can see
 *     which endpoint amplifies the most.
 *
 * **Kill switch.** If `sql` is null (DATABASE_URL unset), this is a
 * silent no-op — same pattern as `pg-cache`. The app keeps working
 * unchanged before the table exists or if Postgres is down.
 *
 * **Sampling.** Defaults to RPC_LOG_SAMPLE (0.1 = 10 %) so a 240 RPM
 * scraper writes ~24 rows/min instead of 240. Aggregations multiply
 * back: `count(*) * 10` ≈ true volume. Per-call override via
 * `{ sample: 1 }` for low-frequency endpoints we want fully captured.
 *
 * **Fire-and-forget.** Insert is never awaited, so a slow Postgres
 * doesn't add latency to the request path. A failed insert is silently
 * dropped; we'd rather miss a sample than 500 the user.
 */

const SALT = process.env.RPC_LOG_SALT ?? ""
const DEFAULT_SAMPLE = Number(process.env.RPC_LOG_SAMPLE ?? "0.1")

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip || ip === "unknown" || !SALT) return null
  return createHash("sha256").update(ip + SALT).digest("hex").slice(0, 16)
}

// Strip query/host/fragment from a Referer header so we don't store URLs
// that might leak wallet addresses in query params, and so referer is
// directly usable as a GROUP BY key. Falls back to null on parse failure.
export function refererPathname(refererHeader: string | null | undefined): string | null {
  if (!refererHeader) return null
  try {
    return new URL(refererHeader).pathname
  } catch {
    return null
  }
}

// Pull just the host portion of an upstream RPC URL — we don't need the
// API key or full path in the log, just "alchemy.com" vs "llamarpc.com".
export function upstreamHost(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// API routes wrap their handler in `withRouteContext("/api/...", fn)` so
// that nested lib calls — which would otherwise need an explicit `route`
// param threaded through every signature — pick up the originating route
// for free. Only used as a fallback: an explicit `route` argument always
// wins. Kept narrow to this single concern.
const routeStorage = new AsyncLocalStorage<string>()

export function withRouteContext<T>(route: string, fn: () => Promise<T> | T): Promise<T> | T {
  return routeStorage.run(route, fn)
}

export function currentRoute(): string | undefined {
  return routeStorage.getStore()
}

export type RpcEvent = {
  source: "proxy" | "server"
  route?: string | null
  method: string
  referer?: string | null
  ipHash?: string | null
  durationMs?: number
  status?: number
  upstream?: string | null
  ok: boolean
}

export function logRpcEvent(ev: RpcEvent, opts?: { sample?: number }) {
  if (!sql) return
  const sample = opts?.sample ?? DEFAULT_SAMPLE
  if (sample < 1 && Math.random() > sample) return
  const route = ev.route ?? currentRoute() ?? null
  void sql`
    INSERT INTO rpc_events (
      source, route, method, referer, ip_hash,
      duration_ms, status, upstream, ok
    ) VALUES (
      ${ev.source},
      ${route},
      ${ev.method},
      ${ev.referer ?? null},
      ${ev.ipHash ?? null},
      ${ev.durationMs ?? null},
      ${ev.status ?? null},
      ${ev.upstream ?? null},
      ${ev.ok}
    )
  `.catch(() => {})
}

/**
 * `http(url)` with each JSON-RPC request sampled into the rpc_events
 * table. Sampling is tighter (5 %) than the default 10 % because viem
 * batches plus multicall fan-outs can produce hundreds of upstream
 * calls per API request — full sampling would dominate the table.
 *
 * Lives here (rather than alongside `getAlchemyMainnetUrl` in
 * alchemy-rpc.ts) so that any module-graph path leading to a client
 * component can keep importing the URL helper without dragging
 * "server-only" into the client bundle.
 */
const VIEM_LOG_SAMPLE = 0.05

export function loggingHttpTransport(
  url: string,
  route: string | undefined,
  config?: HttpTransportConfig,
): Transport {
  const inner = http(url, config)
  const host = upstreamHost(url)
  return ((transportConfig) => {
    const transport = inner(transportConfig)
    const origRequest = transport.request
    const wrapped = {
      ...transport,
      request: async (args: { method?: string }) => {
        const t0 = Date.now()
        const method = args?.method ?? "unknown"
        try {
          const result = await origRequest(
            args as Parameters<typeof origRequest>[0],
          )
          logRpcEvent(
            {
              source: "server",
              route,
              method,
              durationMs: Date.now() - t0,
              upstream: host,
              ok: true,
            },
            { sample: VIEM_LOG_SAMPLE },
          )
          return result
        } catch (e) {
          logRpcEvent(
            {
              source: "server",
              route,
              method,
              durationMs: Date.now() - t0,
              upstream: host,
              ok: false,
            },
            { sample: VIEM_LOG_SAMPLE },
          )
          throw e
        }
      },
    }
    return wrapped as ReturnType<typeof inner>
  }) as Transport
}
