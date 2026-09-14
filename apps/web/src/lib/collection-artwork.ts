import "server-only"
import type { Collection } from "./collection"
import { getLatestCollectionTokenIds } from "./indexer-queries"
import { getDisplayMedia, type DisplayMedia } from "./display-media"
import { collectionMediaUrl } from "./collection-media-url"

/**
 * Display media per collection, keyed by lowercase address: the
 * RenderAssets cover when set, else the display media of the latest live
 * token (token_metadata / token_media_delivery, both warmed by the
 * worker). Two Postgres reads for the whole list, no chain reads.
 * Collections with neither are absent.
 */
export async function getCollectionArtwork(
  collections: Collection[],
): Promise<Map<string, DisplayMedia>> {
  const artwork = new Map<string, DisplayMedia>()
  const uncovered: string[] = []
  for (const c of collections) {
    const key = c.address.toLowerCase()
    if (c.cover) {
      // A RenderAssets cover is an onchain-read URI with no size bound: it
      // can be an inline `data:` document (a full generative HTML page).
      // Route it through the collection media API the same way an inline
      // token image is routed, instead of inlining it into page HTML.
      artwork.set(key, {
        kind: "image",
        src: collectionMediaUrl(c.address, c.cover),
        width: null,
        height: null,
      })
    } else {
      uncovered.push(key)
    }
  }
  if (uncovered.length === 0) return artwork
  try {
    const latest = await getLatestCollectionTokenIds(uncovered)
    const refs = Array.from(latest, ([contract, tokenId]) => ({ contract, tokenId }))
    const media = await getDisplayMedia(refs)
    for (const [contract, tokenId] of latest) {
      const display = media.get(`${contract}:${tokenId}`)
      if (display) artwork.set(contract, display)
    }
  } catch {
    // Missing tables or a slow read leave those cards without artwork.
  }
  return artwork
}
