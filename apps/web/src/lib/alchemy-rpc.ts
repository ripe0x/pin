/**
 * Server-side Mainnet RPC resolution. One source of truth so every server
 * client shares the same provider ladder.
 *
 * The ranked list, primary first:
 *   1. Tenderly's public gateway — the default. Free, no key, serves the
 *      full JSON-RPC method set this app uses (eth_call, eth_getLogs with
 *      topic filters, ENS resolution) and, unlike publicnode, does not
 *      403-gate archive eth_getLogs. Web reads default here so the paid
 *      Alchemy quota is spared for where reliability actually bites.
 *   2. Other anonymous public providers, as automatic failovers.
 *   3. Alchemy — a last-resort backstop, appended ONLY when explicitly
 *      configured (`ALCHEMY_MAINNET_URL` override, or `ALCHEMY_API_KEY`).
 *      Never leads: the public providers serve these reads, so paid quota
 *      stays untouched unless every public provider fails at once.
 *
 * viem's `fallback` transport rotates to the next URL on any error, so a
 * single dead or rate-limited provider doesn't take the site down.
 *
 * Server-only — never imported from a `"use client"` file. Reads
 * server-side env vars (`ALCHEMY_API_KEY` has no `NEXT_PUBLIC_`
 * prefix on purpose).
 */
import { fallback, http, type Transport } from "viem"

// Tenderly's public gateway leads (see file header). The remaining
// providers are anonymous public mainnet RPCs, ranked by reliability, all
// serving the standard JSON-RPC method set this app uses (eth_call,
// eth_getLogs with indexed-arg topic filters, eth_blockNumber, ENS
// resolution). Order matters: viem's `fallback` tries the first, then
// rotates to the next on error.
const PUBLIC_PROVIDERS = [
  "https://gateway.tenderly.co/public/mainnet",
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://1rpc.io/eth",
  "https://cloudflare-eth.com",
]

// The Alchemy backstop URL when `ALCHEMY_MAINNET_URL` or `ALCHEMY_API_KEY`
// is set, else null. Appended last in the ladder, never primary.
function alchemyBackstopUrl(): string | null {
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return explicit
  const key = process.env.ALCHEMY_API_KEY
  if (key && !key.startsWith("set-")) {
    return `https://eth-mainnet.g.alchemy.com/v2/${key}`
  }
  return null
}

/**
 * The primary single URL (Tenderly by default). For the few callers that
 * need one URL string rather than the failover ladder; prefer
 * `getMainnetTransport()` everywhere else.
 */
export function getMainnetPrimaryUrl(): string {
  return getMainnetRpcUrls()[0]
}

/**
 * The full ranked URL list: public providers (Tenderly first) followed by
 * the Alchemy backstop when configured. Exposed so callers that need raw
 * URLs can build their own fallback transport.
 */
export function getMainnetRpcUrls(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of PUBLIC_PROVIDERS) {
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  const backstop = alchemyBackstopUrl()
  if (backstop && !seen.has(backstop)) out.push(backstop)
  return out
}

/**
 * Multi-provider viem transport with automatic failover. Use this in
 * `createPublicClient({ transport: getMainnetTransport() })` so a single
 * provider's outage or quota cap doesn't take the site down.
 *
 * `retryCount: 0` per transport is deliberate. viem's default is to
 * retry each transport ~3 times before moving on, which means a fully
 * dead primary (e.g. an Alchemy app that's been disabled — returns 403
 * on every call) burns ~3× retry delay before the fallback kicks in.
 * For an `/api/record` server-render, that turns into 20s of "Loading…"
 * for the user. Setting per-transport retries to 0 lets fallback
 * immediately rotate to the next provider on any error — transient
 * blips lose the per-provider retry, but if the blip really is just a
 * blip the next provider in the list will serve it.
 */
export function getMainnetTransport(): Transport {
  return fallback(
    getMainnetRpcUrls().map((url) => http(url, { retryCount: 0 })),
  )
}
