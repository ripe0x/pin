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
 *  - refs: `["artist-token-refs", "vN", artistAddress]` — one entry per
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

/**
 * Thrown by `getCachedEnrichedPage` when enrichment returns zero usable
 * tokens for a non-empty input. Mirrors the `IndexerUnavailable` pattern
 * from `indexer-queries.ts` and the activity-feed fix in #32: throwing
 * (instead of returning `[]`) keeps `unstable_cache` from persisting the
 * failure, so the next render retries fresh instead of serving a poisoned
 * empty array for the full 24h TTL.
 *
 * The caller (`getArtistGalleryPage`) catches and renders an empty page.
 * Visual outcome on the failure render is the same as today; the
 * improvement is that the next visitor's render isn't pre-poisoned.
 */
export class EnrichmentEmpty extends Error {
  constructor() {
    super("enrichment returned no usable tokens")
    this.name = "EnrichmentEmpty"
  }
}

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
  async (refs: TokenRef[]): Promise<DiscoveredToken[]> => {
    const enriched = await enrichTokens(refs)
    // Don't poison the 24h cache with an empty result when there were
    // refs to enrich — that's the symptom of a transient RPC/IPFS
    // hiccup during cold fill (multicall timeout + metadata gateway
    // miss), not a real "this artist has no tokens" signal. We hit
    // this in production: an artist with 24 Manifold tokens cached as
    // `[]` and stayed empty for 24h until someone hit /api/revalidate.
    // Bumping the cache key (v5→v6) below clears existing poisoned
    // entries on deploy.
    if (refs.length > 0 && enriched.length === 0) {
      throw new EnrichmentEmpty()
    }
    return enriched
  },
  ["artist-enriched-page", "v6"],
  { revalidate: 86_400, tags: ["artist-enriched"] },
)
