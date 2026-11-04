/**
 * Server-side read for the artist's optional Surface collection.
 *
 * Mirrors `lib/auctions.ts`'s pattern: a cheap, cached, server-rendered
 * snapshot that the client mint card then keeps live (see
 * components/CollectionMintCard.tsx). Only used when
 * `NEXT_PUBLIC_COLLECTION_ADDRESS` is set — see lib/config.ts.
 *
 * The detection itself (v1 or v2, which sale, its live state) lives in the
 * client-safe lib/surface-reads.ts so the mint card refreshes through the
 * same code. This module only adds the server cache.
 *
 * `unstable_cache` JSON-serializes its return value, and JSON.stringify
 * throws on a bigint, so the cached value is the serialized form (bigints as
 * decimal strings) and is rebuilt at the public boundary.
 */
import "server-only"
import { unstable_cache } from "next/cache"
import { type Address } from "viem"
import { getClient } from "./rpc"
import { getConfig } from "./config"
import { readCollectionSummary } from "./surface-reads"
import {
  deserializeCollection,
  serializeCollection,
  type CollectionSummary,
  type SerializedCollectionSummary,
} from "./surface"

const _getCollectionCached = unstable_cache(
  async (address: Address): Promise<SerializedCollectionSummary | null> => {
    try {
      const summary = await readCollectionSummary(getClient(), address)
      return summary ? serializeCollection(summary) : null
    } catch {
      return null
    }
  },
  // Bumped from v1: the cached shape changed with the Surface v1+v2 rebind.
  ["collection-summary-v2"],
  // Short TTL: minted counts move with every sale. The mint card re-reads
  // live in the browser, so this only covers first paint.
  { revalidate: 20, tags: ["collection"] },
)

/** The configured collection's summary, or null if unset/unreadable. */
export async function getCollection(): Promise<CollectionSummary | null> {
  const { collectionAddress } = getConfig()
  if (!collectionAddress) return null
  const raw = await _getCollectionCached(collectionAddress)
  return raw ? deserializeCollection(raw) : null
}
