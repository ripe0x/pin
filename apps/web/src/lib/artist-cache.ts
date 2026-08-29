/**
 * `unstable_cache` wrappers for the two phases of artist discovery.
 *
 * Both layers use a 24h TTL — long enough to absorb repeat traffic, short
 * enough that fresh work shows up "by the next day" without intervention.
 * A completed durable artist refresh invalidates the address-specific tags;
 * the authenticated global revalidation route can still flush all artists.
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
  filterOutBurnedRefs,
  type TokenRef,
  type DiscoveredToken,
} from "./onchain-discovery"
import { artistEnrichedTag, artistRefsTag } from "./refresh-jobs"

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
export async function getCachedTokenRefs(
  artistAddress: string,
  indexedOnly = false,
): Promise<TokenRef[]> {
  const lower = artistAddress.toLowerCase()
  return unstable_cache(
    async (): Promise<TokenRef[]> =>
      filterOutBurnedRefs(await discoverArtistTokenRefs(lower, {
        includeCourtesyChainReads: !indexedOnly,
      })),
    // The address is both an explicit key part and an invalidation tag. A
    // completed durable refresh can evict only this artist instead of forcing
    // every gallery cold.
    ["artist-token-refs", "v9", indexedOnly ? "indexed" : "courtesy", lower],
    { revalidate: 86_400, tags: ["artist-refs", artistRefsTag(lower)] },
  )()
}

export async function getCachedEnrichedPage(
  refs: TokenRef[],
  artistAddress?: string,
): Promise<DiscoveredToken[]> {
  const lower = artistAddress?.toLowerCase()
  return unstable_cache(
    async (): Promise<DiscoveredToken[]> => {
      // Public profile requests are database reads only. Missing metadata is
      // an explicit indexed state for the worker to resolve, never permission
      // for a page render to fan out tokenURI/uri RPC calls.
      const enriched = await enrichTokens(refs, { resolveMissing: false })
      // Don't poison the 24h cache with an empty result when there were
      // refs to enrich. That is the symptom of a transient metadata miss,
      // not a real "this artist has no tokens" signal.
      if (refs.length > 0 && enriched.length === 0) {
        throw new EnrichmentEmpty()
      }
      return enriched
    },
    // refs are part of the key so different pages cannot collide. The optional
    // artist tag lets a successful refresh evict every enriched page for that
    // artist while non-gallery callers retain the shared global tag.
    ["artist-enriched-page", "v8", lower ?? "shared", JSON.stringify(refs)],
    {
      revalidate: 86_400,
      tags: [
        "artist-enriched",
        ...(lower ? [artistEnrichedTag(lower)] : []),
      ],
    },
  )()
}
