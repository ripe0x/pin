/**
 * Server-side mainnet RPC resolution. One source of truth so callers
 * can't drift apart and so the deploy environment only needs a single
 * env var (`ALCHEMY_API_KEY`) to work end-to-end.
 *
 * Two exports:
 *   - `getAlchemyMainnetUrl()` — the URL string, for the rare caller
 *     that needs to proxy through fetch (`/api/rpc/route.ts`).
 *   - `getMainnetTransport(route?, config?)` — a viem transport with
 *     automatic failover to public llamarpc. Use this for every
 *     `createPublicClient` in the codebase.
 *
 * URL resolution order:
 *   1. `ALCHEMY_MAINNET_URL` if explicitly set — escape hatch for
 *      pointing at a non-Alchemy provider (drpc, self-hosted node) or
 *      a different Alchemy app per environment.
 *   2. `ALCHEMY_API_KEY` if set — built into the canonical Alchemy
 *      mainnet URL. This is the common path; setting just the key on
 *      Netlify makes everything work.
 *   3. Public llamarpc as a last-ditch fallback so dev environments
 *     without any Alchemy credentials still spin up. Throttled and
 *     unreliable for production traffic — surface a console.warn so
 *     the operator notices.
 *
 * Failover (transport only): even when Alchemy IS configured, the
 * transport falls back to public llamarpc when Alchemy throws (network
 * error, 429, monthly-cap quota exceeded). Without failover, a single
 * quota cap takes the whole site down.
 *
 * Server-only — never imported from a `"use client"` file. The
 * function reads server-side env vars (`ALCHEMY_API_KEY` does NOT
 * have the `NEXT_PUBLIC_` prefix on purpose) and would resolve to
 * undefined if reached from a client bundle.
 */
import {
  fallback,
  type HttpTransportConfig,
  type Transport,
} from "viem"
import { loggingHttpTransport } from "./rpc-log"

const FALLBACK_URL = "https://eth.llamarpc.com"

let warned = false

export function getAlchemyMainnetUrl(): string {
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return explicit

  const key = process.env.ALCHEMY_API_KEY
  if (key) return `https://eth-mainnet.g.alchemy.com/v2/${key}`

  if (!warned) {
    warned = true
    // eslint-disable-next-line no-console
    console.warn(
      "[alchemy-rpc] ALCHEMY_API_KEY and ALCHEMY_MAINNET_URL are both unset; falling back to public llamarpc. Reads will throttle and many archive queries will fail.",
    )
  }
  return FALLBACK_URL
}

/**
 * Mainnet viem transport with automatic failover. Primary = Alchemy (or
 * whatever URL is configured via env). Secondary = public llamarpc.
 *
 * Viem's `fallback` retries the next transport on network error, 5xx,
 * or 429. That includes Alchemy's "Monthly capacity exceeded" responses
 * (HTTP 429), so a quota cap automatically drops to llamarpc instead of
 * breaking the page.
 *
 * Both legs are wrapped with `loggingHttpTransport` so `rpc_events`
 * still attributes each upstream call. When the secondary serves, you
 * see its host in the logs — that's the signal to refresh the Alchemy
 * key / quota.
 *
 * If the primary IS already llamarpc (env unset entirely), no secondary
 * is added — there's nothing to fall back to.
 */
export function getMainnetTransport(
  route?: string,
  config?: HttpTransportConfig,
): Transport {
  const primary = getAlchemyMainnetUrl()
  if (primary === FALLBACK_URL) {
    return loggingHttpTransport(primary, route, config)
  }
  return fallback(
    [
      loggingHttpTransport(primary, route, config),
      loggingHttpTransport(FALLBACK_URL, route, config),
    ],
    // Primary always first; viem's auto-rank would otherwise probe both
    // and route by latency, which is not what we want here.
    { rank: false },
  )
}
