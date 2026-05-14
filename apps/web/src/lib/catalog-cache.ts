import "server-only"
import { unstable_cache } from "next/cache"
import type { Address } from "viem"
import { getCatalog, type Catalog } from "./catalog"

/**
 * Request-scoped dedupe wrapper around `getCatalog`. The underlying
 * read is Ponder-backed (Postgres SELECTs against the catalog_* tables,
 * with the viem-multicall path as a fallback when the indexer is
 * unreachable — see `./catalog.ts`), so Postgres itself IS the cache
 * layer; we no longer wrap with `pgCache` like we did before the
 * indexer existed.
 *
 * `unstable_cache` still earns its keep: a single request that touches
 * both `/record/[address]` (renders the full record) and the artist
 * page's `CatalogSection` (renders the same record as a sub-section)
 * collapses into one Postgres roundtrip. The `tags: ["catalog"]`
 * entry stays so the post-write revalidate route can dump the per-
 * request memoization across all artists in one call.
 */
const RECORD_TTL_S = 60

export const getCachedCatalog = unstable_cache(
  (addressLower: string): Promise<Catalog> =>
    getCatalog(addressLower as Address),
  ["catalog-v2"],
  { revalidate: RECORD_TTL_S, tags: ["catalog"] },
)
