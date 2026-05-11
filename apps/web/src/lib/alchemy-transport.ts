import "server-only"
import {
  fallback,
  type HttpTransportConfig,
  type Transport,
} from "viem"
import {
  FALLBACK_MAINNET_RPC_URL,
  getAlchemyMainnetUrl,
} from "./alchemy-rpc"
import { loggingHttpTransport } from "./rpc-log"

/**
 * Mainnet viem transport with automatic failover. Primary = Alchemy (or
 * whatever URL is configured via env). Secondary = public llamarpc.
 *
 * Viem's `fallback` retries the next transport on network error, 5xx,
 * or 429 — including Alchemy's "Monthly capacity exceeded" responses
 * (HTTP 429) — so a quota cap automatically drops to llamarpc instead
 * of breaking the page.
 *
 * Both legs are wrapped with `loggingHttpTransport` so `rpc_events`
 * attributes each upstream call. When the secondary serves, you see
 * its host in the logs — that's the signal to refresh the Alchemy key
 * / quota.
 *
 * If the primary IS already llamarpc (env unset entirely), no secondary
 * is added — there's nothing to fall back to.
 *
 * Server-only because `loggingHttpTransport` transitively imports the
 * `db.ts` Postgres client. Use this for every `createPublicClient` call
 * in server modules. For client-safe modules that just need the URL
 * (rare — typically a proxy), import `getAlchemyMainnetUrl` from
 * `./alchemy-rpc`.
 */
export function getMainnetTransport(
  route?: string,
  config?: HttpTransportConfig,
): Transport {
  const primary = getAlchemyMainnetUrl()
  if (primary === FALLBACK_MAINNET_RPC_URL) {
    return loggingHttpTransport(primary, route, config)
  }
  return fallback(
    [
      loggingHttpTransport(primary, route, config),
      loggingHttpTransport(FALLBACK_MAINNET_RPC_URL, route, config),
    ],
    { rank: false },
  )
}
