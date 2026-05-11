/**
 * Mainnet RPC URL resolution. Client-safe — no `"server-only"` import and
 * no transitive server-only dependencies, so `client-safe` modules like
 * `seller-listings.ts` (which is reachable from `"use client"` components)
 * can import this freely.
 *
 * For server-side viem clients with automatic failover + per-route
 * logging, use `getMainnetTransport()` from `./alchemy-transport`.
 *
 * Resolution order:
 *   1. `ALCHEMY_MAINNET_URL` if explicitly set — escape hatch for
 *      pointing at a non-Alchemy provider (drpc, self-hosted node) or
 *      a different Alchemy app per environment.
 *   2. `ALCHEMY_API_KEY` if set — built into the canonical Alchemy
 *      mainnet URL. This is the common path; setting just the key on
 *      Netlify makes everything work.
 *   3. Public llamarpc as a last-ditch fallback so dev environments
 *     without any Alchemy credentials still spin up.
 *
 * Server-side env vars (`ALCHEMY_API_KEY` deliberately lacks the
 * `NEXT_PUBLIC_` prefix) resolve to `undefined` in the client bundle,
 * which means client callers automatically fall through to llamarpc.
 */

export const FALLBACK_MAINNET_RPC_URL = "https://eth.llamarpc.com"

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
  return FALLBACK_MAINNET_RPC_URL
}
