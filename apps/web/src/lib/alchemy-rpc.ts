/**
 * Server-side Alchemy URL resolution. One source of truth so callers
 * can't drift apart and so the deploy environment only needs a single
 * env var (`ALCHEMY_API_KEY`) to work end-to-end.
 *
 * Resolution order:
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
 * Server-only — never imported from a `"use client"` file. The
 * function reads server-side env vars (`ALCHEMY_API_KEY` does NOT
 * have the `NEXT_PUBLIC_` prefix on purpose) and would resolve to
 * undefined if reached from a client bundle.
 */

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
