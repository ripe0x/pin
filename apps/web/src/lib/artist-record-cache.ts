import "server-only"
import { unstable_cache } from "next/cache"
import { pgCache } from "./pg-cache"
import type { Address } from "viem"
import {
  getArtistRecordWithChain,
  type ArtistRecordWithChain,
} from "./artist-record"

/**
 * Cached wrapper around `getArtistRecordWithChain` so the result page,
 * the /api/record/[address] route, and the dependency-report
 * orchestrator share a single cached view per address. 5-min two-layer
 * cache like the other report endpoints.
 *
 * Lives in its own file (vs. `artist-record.ts`) so the underlying
 * read helper can be imported into write-flow client components and
 * other contexts that don't want the next/cache dependency dragged in.
 */
const RECORD_TTL_S = 5 * 60

export const getCachedArtistRecord = unstable_cache(
  (addressLower: string): Promise<ArtistRecordWithChain> =>
    pgCache<ArtistRecordWithChain>(
      `artist-record:${addressLower}`,
      RECORD_TTL_S,
      () => getArtistRecordWithChain(addressLower as Address),
    ),
  ["artist-record-v1"],
  { revalidate: RECORD_TTL_S, tags: ["artist-record"] },
)
