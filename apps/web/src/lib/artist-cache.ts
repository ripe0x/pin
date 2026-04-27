/**
 * `unstable_cache` wrappers for the two phases of artist discovery.
 *
 * Both layers use a 24h TTL — short enough that newly minted work shows up
 * by the next day, long enough to absorb the bulk of repeat traffic.
 *
 * Cache key shape:
 *  - refs: `["artist-token-refs", "v1", artistAddress]` — one entry per artist
 *  - enriched page: derived from the array of refs passed in. Refs are plain
 *    JSON objects (no bigint), so they hash deterministically; revisiting
 *    page N for the same artist hits the cache.
 */
import { unstable_cache } from "next/cache"
import {
  discoverArtistTokenRefs,
  enrichTokens,
  type TokenRef,
  type DiscoveredToken,
} from "./onchain-discovery"

export const getCachedTokenRefs = unstable_cache(
  async (artistAddress: string): Promise<TokenRef[]> =>
    discoverArtistTokenRefs(artistAddress),
  ["artist-token-refs", "v1"],
  { revalidate: 86_400, tags: ["artist-refs"] },
)

export const getCachedEnrichedPage = unstable_cache(
  async (refs: TokenRef[]): Promise<DiscoveredToken[]> => enrichTokens(refs),
  ["artist-enriched-page", "v1"],
  { revalidate: 86_400 },
)
