import type { Address } from "viem"

/**
 * Hardcoded allowlist of mainnet contracts that are known to host
 * works from multiple artists. The import planner blocks the
 * "Register whole contract" option for any contract on this list —
 * calling `addContract(c)` on a shared platform contract would
 * implicitly claim every other artist's tokens on it.
 *
 * Each entry should cite its platform and the rationale so future
 * additions are sanity-checkable.
 *
 * Addresses are stored lowercased; lookups always normalize.
 */
export const KNOWN_SHARED_CONTRACTS: Record<Address, { platform: string; note: string }> = {
  // SuperRare V2 — the canonical SR ERC-721. Thousands of artists.
  "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0": {
    platform: "SuperRare V2",
    note: "Shared 1/1 contract for the entire SuperRare marketplace.",
  },
  // OpenSea Shared Storefront (ERC-1155). Lazy-minted "Untitled Collection"
  // works by anyone who didn't deploy their own contract.
  "0x495f947276749ce646f68ac8c248420045cb7b5e": {
    platform: "OpenSea Shared Storefront",
    note: "Lazy-mint contract used by anyone via OpenSea's old shared collection.",
  },
  // Foundation shared 1/1 contract — pre-Surface artists minted here.
  "0x3b3ee1931dc30c1957379fac9aba94d1c48a5405": {
    platform: "Foundation",
    note: "Foundation's pre-Surface shared 1/1 contract.",
  },
  // Rarible v2 multi-token (ERC-1155). Multi-artist by design.
  "0xd07dc4262bcdbf85190c01c996b4c06a461d2430": {
    platform: "Rarible v2",
    note: "Rarible multi-token ERC-1155 shared across collectors/artists.",
  },
  // KnownOrigin v3 — shared editions/1-of-1 contract pre-platform-shutdown.
  "0xfbeef911dc5821886e1dda71586d90ed28174b7d": {
    platform: "KnownOrigin v3",
    note: "KnownOrigin's shared 1/1 and edition contract.",
  },
  // Async Art Blueprints — multi-artist generative contract.
  "0xc143bbfcdbdbed6d454803804752a064a622c1f3": {
    platform: "Async Art",
    note: "Async Art Blueprints — multi-artist generative system.",
  },
  // OpenSea Wyvern V2 / shared storefront variants below if encountered;
  // add here when new shared contracts surface in artist registries.
  // Pattern: anything mintable by arbitrary addresses without a per-artist
  // proxy is "shared" for our purposes.
}

export function isSharedContract(contract: Address): boolean {
  return (contract.toLowerCase() as Address) in KNOWN_SHARED_CONTRACTS
}

export function sharedContractInfo(contract: Address) {
  return KNOWN_SHARED_CONTRACTS[contract.toLowerCase() as Address] ?? null
}
