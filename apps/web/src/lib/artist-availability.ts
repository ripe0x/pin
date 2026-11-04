import "server-only"
import { unstable_cache } from "next/cache"
import { sql } from "./db"
import { INDEXER_SCHEMA } from "./indexer-schema"
import { getCachedTokenRefs } from "./artist-cache"
import {
  loadAvailabilityTables,
  pgTextArray,
  saleStateForKeysSql,
  saleStateMap,
  type SaleState,
  type SaleStateRow,
} from "./availability"

/**
 * Sale state (live auction / listed) for every one of an artist's works,
 * keyed `contract:tokenId`, from Postgres only (lib/availability.ts).
 * Feeds the gallery's availability ranking, which has to see the whole
 * inventory before it paginates.
 *
 * Cached 60s per artist: listings move far faster than the 24h refs
 * cache, but a burst of gallery page loads shouldn't each re-run the
 * join. One indexed query per miss, over the artist's refs.
 */
const SALE_STATE_TTL_SECONDS = 60

function cachedSaleRows(lower: string): Promise<SaleStateRow[]> {
  return unstable_cache(
    async (): Promise<SaleStateRow[]> => {
      if (!sql) return []
      const refs = await getCachedTokenRefs(lower)
      if (refs.length === 0) return []
      const tables = await loadAvailabilityTables(sql, INDEXER_SCHEMA)
      if (!Object.values(tables).some(Boolean)) return []
      // Throws on failure, so unstable_cache never stores a failed read.
      return (await sql.unsafe(saleStateForKeysSql(INDEXER_SCHEMA, tables), [
        pgTextArray(refs.map((r) => r.contract.toLowerCase())),
        pgTextArray(refs.map((r) => String(r.tokenId))),
      ])) as unknown as SaleStateRow[]
    },
    ["artist-sale-state", "v1", lower],
    { revalidate: SALE_STATE_TTL_SECONDS, tags: ["artist-availability"] },
  )()
}

/** Empty map (gallery falls back to mint recency) when the read fails. */
export async function getArtistSaleStates(artistAddress: string): Promise<Map<string, SaleState>> {
  try {
    return saleStateMap(await cachedSaleRows(artistAddress.toLowerCase()))
  } catch (err) {
    console.error("[artist-availability] sale state read failed:", err)
    return new Map()
  }
}
