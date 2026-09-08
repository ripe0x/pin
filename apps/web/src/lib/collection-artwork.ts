import "server-only"
import { ipfsToHttp } from "@pin/shared"
import type { Collection } from "./collection"
import {
  getLatestCollectionTokenIds,
  getTokenImagesFromMetadata,
} from "./indexer-queries"

/**
 * Display image per collection, keyed by lowercase address: the
 * RenderAssets cover when set, else the stored image of the latest live
 * token (token_metadata, warmed by the worker). Two Postgres reads for the
 * whole list, no chain reads. Collections with neither are absent.
 */
export async function getCollectionArtwork(
  collections: Collection[],
): Promise<Map<string, string>> {
  const artwork = new Map<string, string>()
  const uncovered: string[] = []
  for (const c of collections) {
    const key = c.address.toLowerCase()
    if (c.cover) artwork.set(key, c.cover)
    else uncovered.push(key)
  }
  if (uncovered.length === 0) return artwork
  try {
    const latest = await getLatestCollectionTokenIds(uncovered)
    const pairs = Array.from(latest, ([contract, tokenId]) => ({ contract, tokenId }))
    const images = await getTokenImagesFromMetadata(pairs)
    for (const [contract, tokenId] of latest) {
      const src = images.get(`${contract}:${tokenId}`)
      if (!src) continue
      // Inline (data:) images can run to hundreds of KB; reference them by
      // URL so they never land in the page HTML.
      artwork.set(
        contract,
        src.startsWith("data:")
          ? `/api/collections/${contract}/token-image/${tokenId}`
          : ipfsToHttp(src),
      )
    }
  } catch {
    // Missing tables or a slow read leave those cards without artwork.
  }
  return artwork
}
