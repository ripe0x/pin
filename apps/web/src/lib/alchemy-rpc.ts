/**
 * Server-side Mainnet RPC URL resolution. One source of truth so callers
 * can't drift apart and so the deploy environment only needs a single
 * env var (`INFURA_API_KEY` or `ALCHEMY_API_KEY`) to work end-to-end.
 *
 * Returns a ranked list, primary first:
 *   1. `MAINNET_RPC_URL` / `ALCHEMY_MAINNET_URL` if explicitly set —
 *      escape hatch for pointing at any provider (self-hosted node,
 *      drpc, QuickNode) or a different app per environment.
 *   2. `INFURA_API_KEY` if set — built into the Infura mainnet URL.
 *   3. `ALCHEMY_API_KEY` if set — built into the Alchemy mainnet URL.
 *   4. Public providers, in order of historical reliability. Used as
 *      automatic fallbacks when the primary fails (rate-limited, capped,
 *      503'd, etc.). The viem `fallback` transport rotates through them
 *      until one returns a successful response, so a single dead provider
 *      doesn't take the site down.
 *
 * When both Infura and Alchemy keys are set, Infura is preferred as the
 * primary and Alchemy is inserted into the fallback chain ahead of the
 * public providers — that way a healthy Alchemy account picks up the
 * load before we degrade to rate-limited public RPCs.
 *
 * Server-only — never imported from a `"use client"` file. Reads
 * server-side env vars (`*_API_KEY` has no `NEXT_PUBLIC_` prefix on
 * purpose).
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

function infuraUrl(): string | null {
  const key = process.env.INFURA_API_KEY
  if (!key) return null
  return `https://mainnet.infura.io/v3/${key}`
}

function alchemyUrl(): string | null {
  const key = process.env.ALCHEMY_API_KEY
  if (!key) return null
  return `https://eth-mainnet.g.alchemy.com/v2/${key}`
}

/**
 * Primary URL only. Most places want the multi-URL transport via
 * `getMainnetTransport()` — this helper is preserved for the few
 * call sites that need a single URL string (e.g. Ponder's standalone
 * sync config, IPFS gateway selection logging).
 *
 * Order: explicit override, Infura, Alchemy, public fallback.
 */
export function getAlchemyMainnetUrl(): string {
  const explicit =
    process.env.MAINNET_RPC_URL ?? process.env.ALCHEMY_MAINNET_URL
  if (explicit) return explicit
  const infura = infuraUrl()
  if (infura) return infura
  const alchemy = alchemyUrl()
  if (alchemy) return alchemy
  if (!warned) {
    warned = true
    // eslint-disable-next-line no-console
    console.warn(
      "[alchemy-rpc] No INFURA_API_KEY, ALCHEMY_API_KEY, or MAINNET_RPC_URL set; falling back to public providers. Reads will throttle and archive queries may fail.",
    )
  }
  return PUBLIC_FALLBACKS[0]
}

/**
 * The full ranked URL list: primary first, then any other configured
 * paid provider (so a healthy Alchemy account picks up the load if
 * Infura caps out), then every public fallback. Exposed so callers that
 * need raw URLs (e.g. the multicall path that constructs its own client
 * per route attribution) can build their own fallback transport.
 */
export function getMainnetRpcUrls(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (url: string | null) => {
    if (!url) return
    if (seen.has(url)) return
    seen.add(url)
    out.push(url)
  }
  // Primary (explicit override takes precedence over keyed providers).
  push(getAlchemyMainnetUrl())
  // Secondary keyed providers: keep both in the chain when both keys are
  // present, so the paid provider absorbs a primary outage before we
  // degrade to public rate-limited RPCs.
  push(infuraUrl())
  push(alchemyUrl())
  // Public last-resort tier.
  for (const url of PUBLIC_FALLBACKS) push(url)
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
