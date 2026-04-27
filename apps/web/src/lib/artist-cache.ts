/**
 * `unstable_cache` wrappers for the two phases of artist discovery.
 *
 * Both layers use a 24h TTL — long enough to absorb repeat traffic, short
 * enough that fresh work shows up "by the next day" without intervention.
 * For artists who want their new mint to appear immediately, hit the manual
 * flush endpoint at `/api/revalidate?secret=…` after minting (the tags
 * below are what that endpoint targets).
 *
 * Cache key shape:
 *  - refs: `["artist-token-refs", "v4", artistAddress]` — one entry per
 *    artist (the function arg becomes part of the cache key).
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

// Bump the version suffix to invalidate every existing cache entry on the
// next deploy. Use this when you change discovery logic OR when an artist
// has already minted and the existing pre-tag cache entries can't be
// flushed via revalidateTag (which only matches entries written with the
// new tag).
export const getCachedTokenRefs = unstable_cache(
  async (artistAddress: string): Promise<TokenRef[]> =>
    discoverArtistTokenRefs(artistAddress),
  ["artist-token-refs", "v5"],
  { revalidate: 86_400, tags: ["artist-refs"] },
)

export const getCachedEnrichedPage = unstable_cache(
  async (refs: TokenRef[]): Promise<DiscoveredToken[]> => enrichTokens(refs),
  ["artist-enriched-page", "v5"],
  { revalidate: 86_400, tags: ["artist-enriched"] },
)
