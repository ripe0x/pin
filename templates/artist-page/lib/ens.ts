/**
 * Server-side ENS resolution with caching.
 *
 * Two callers:
 *
 *  - The artist's own display name (when `NEXT_PUBLIC_ARTIST_NAME` is unset
 *    we do a reverse-resolve on `NEXT_PUBLIC_ARTIST_ADDRESS`).
 *  - Bidder / winner addresses in the auction history.
 *
 * Cached for 6 hours per address — ENS doesn't change often, and a stale
 * read here is harmless. Resolution failures are cached as `null` so we
 * don't re-hammer the RPC on addresses without primary names.
 */
import "server-only"
import { unstable_cache } from "next/cache"
import { type Address } from "viem"
import { getClient } from "./rpc"

/**
 * Reverse-resolve a single address to its primary ENS name. Returns null
 * when the address has no primary set, when forward-confirmation fails
 * (typo-squat protection — viem handles this internally), or when the RPC
 * is unavailable.
 */
export const getEnsName = unstable_cache(
  async (address: Address): Promise<string | null> => {
    const client = getClient()
    try {
      // viem's getEnsName performs both reverse and forward resolution to
      // confirm the name actually controls the address — no need to do it
      // ourselves.
      const name = await client.getEnsName({ address })
      return name ?? null
    } catch {
      return null
    }
  },
  ["ens-name-v1"],
  { revalidate: 60 * 60 * 6, tags: ["ens"] },
)

/**
 * Bulk-resolve a list of addresses. Dedupes before fetching. Returns a
 * map keyed by lowercased address — callers should look up by the
 * lowercased form to avoid case-sensitivity surprises.
 */
export async function getEnsNames(
  addresses: ReadonlyArray<Address | string>,
): Promise<Map<string, string>> {
  const seen = new Set<string>()
  const unique: Address[] = []
  for (const a of addresses) {
    if (!a) continue
    const lower = a.toLowerCase()
    if (seen.has(lower)) continue
    if (lower === "0x0000000000000000000000000000000000000000") continue
    seen.add(lower)
    unique.push(a as Address)
  }
  const results = await Promise.all(
    unique.map(async (a) => [a.toLowerCase(), await getEnsName(a)] as const),
  )
  const map = new Map<string, string>()
  for (const [addr, name] of results) {
    if (name) map.set(addr, name)
  }
  return map
}

// Note: `displayFor` lives in `./format` rather than here so client
// components can import it without pulling in this module's `server-only`
// marker. Server callers that need both ENS resolution and the formatter
// should import them from their respective modules.
