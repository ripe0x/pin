/**
 * Server-side mainnet RPC URL resolution. One source of truth so callers
 * can't drift apart, and provider-neutral so swapping primaries is a
 * one-line env change.
 *
 * Returns a ranked list, primary first:
 *   1. `MAINNET_RPC_URL` if set — the canonical env var. Any JSON-RPC
 *      compatible provider works (Alchemy, Quicknode, drpc, a self-hosted
 *      node). Pass the full URL with credentials inline; no provider-
 *      specific assumptions in code.
 *   2. `ALCHEMY_MAINNET_URL` if set — deprecated alias for #1. Read here
 *      so existing deployments with the older env name don't break on
 *      this PR. Slated for removal after the env var is migrated across
 *      environments.
 *   3. `ALCHEMY_API_KEY` if set — deprecated legacy that derives the
 *      canonical Alchemy URL. Prefer setting `MAINNET_RPC_URL` directly.
 *      Note: `ALCHEMY_API_KEY` is still used (and correctly named) by the
 *      Alchemy NFT enhanced API in `lib/alchemy.ts`. That usage is
 *      legitimate and unaffected — the key is now scoped to NFT-API auth
 *      only, not RPC URL construction.
 *   4. Public providers, in order of historical reliability. Used as
 *      automatic fallbacks when the primary fails (rate-limited, capped,
 *      503'd, etc.). The viem `fallback` transport rotates through them
 *      until one returns a successful response, so a single dead provider
 *      doesn't take the site down.
 *
 * Server-only — never imported from a `"use client"` file. Reads
 * server-side env vars (no `NEXT_PUBLIC_` prefix on purpose).
 */
import { fallback, http, type Transport } from "viem"

// Public providers, ranked by reliability and capacity. All support
// the standard JSON-RPC methods this app uses (eth_call, eth_getLogs
// with indexed-arg topic filters, eth_blockNumber, getEnsAddress
// resolution chain). Order matters: viem's `fallback` tries the first
// transport, retries, then moves to the next.
const PUBLIC_FALLBACKS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://rpc.ankr.com/eth",
  "https://1rpc.io/eth",
  "https://eth-mainnet.public.blastapi.io",
  "https://cloudflare-eth.com",
]

let warned = false

/**
 * Primary URL only. Most places want the multi-URL transport via
 * `getMainnetTransport()` — this helper is preserved for the few
 * call sites that need a single URL string (e.g. Ponder's standalone
 * sync config, IPFS gateway selection logging).
 */
export function getMainnetRpcUrl(): string {
  const explicit = process.env.MAINNET_RPC_URL ?? process.env.ALCHEMY_MAINNET_URL
  if (explicit) return explicit
  const legacyKey = process.env.ALCHEMY_API_KEY
  if (legacyKey) return `https://eth-mainnet.g.alchemy.com/v2/${legacyKey}`
  if (!warned) {
    warned = true
    // eslint-disable-next-line no-console
    console.warn(
      "[rpc] MAINNET_RPC_URL is not set; falling back to public providers. Reads will throttle and archive queries may fail.",
    )
  }
  return PUBLIC_FALLBACKS[0]
}

/**
 * The full ranked URL list: primary (configured or public fallback)
 * followed by every public fallback. Exposed so callers that need raw
 * URLs (e.g. the multicall path that constructs its own client per
 * route attribution) can build their own fallback transport.
 */
export function getMainnetRpcUrls(): string[] {
  const primary = getMainnetRpcUrl()
  // Dedup in case primary is itself one of the public fallbacks (dev
  // sandboxes where neither env var is set).
  const seen = new Set<string>([primary])
  const out: string[] = [primary]
  for (const url of PUBLIC_FALLBACKS) {
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * Multi-provider viem transport with automatic failover. Use this in
 * `createPublicClient({ transport: getMainnetTransport() })` so a single
 * provider's outage or quota cap doesn't take the site down. viem's
 * `fallback` retries the primary a few times before rotating, so a
 * transient blip stays on the primary instead of churning through every
 * provider on each request.
 */
export function getMainnetTransport(): Transport {
  return fallback(getMainnetRpcUrls().map((url) => http(url)))
}
