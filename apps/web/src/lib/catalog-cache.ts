import "server-only"
import { unstable_cache } from "next/cache"
import { pgCache } from "./pg-cache"
import type { Address } from "viem"
import { getCatalog, type Catalog } from "./catalog"

/**
 * Cached wrapper around `getCatalog` so the result page, the
 * /api/record/[address] route, and the dependency-report orchestrator
 * share a single cached view per address. 5-min two-layer cache like
 * the other report endpoints.
 *
 * Lives in its own file (vs. `catalog.ts`) so the underlying
 * read helper can be imported into write-flow client components and
 * other contexts that don't want the next/cache dependency dragged in.
 */
const RECORD_TTL_S = 5 * 60

export const getCachedCatalog = unstable_cache(
  (addressLower: string): Promise<Catalog> =>
    pgCache<Catalog>(
      `catalog:${addressLower}`,
      RECORD_TTL_S,
      () => getCatalog(addressLower as Address),
    ),
  ["catalog-v1"],
  { revalidate: RECORD_TTL_S, tags: ["catalog"] },
)
