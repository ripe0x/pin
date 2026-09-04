import { extractBareCid, ipfsToHttp } from "@pin/shared"
import type { DiscoveredToken } from "./onchain-discovery"

export type IndexedPreserveTokenRow = {
  contract: string
  token_id: string
  name: string | null
  description: string | null
  image_url: string | null
  animation_url: string | null
  raw_uri: string | null
}

/**
 * Restore the legacy DiscoveredToken contract consumed by /preserve from the
 * worker-owned Postgres rows. Pinning providers need bare root CIDs, while the
 * preview keeps the exact indexed media path.
 */
export function toPreserveDiscoveredToken(
  row: IndexedPreserveTokenRow,
  artistAddress: string,
): DiscoveredToken {
  const image = row.image_url
  const animation = row.animation_url

  return {
    contract: row.contract.toLowerCase() as `0x${string}`,
    tokenId: row.token_id,
    creator: artistAddress.toLowerCase() as `0x${string}`,
    collectionName: null,
    platform: "foundation",
    metadata:
      row.name || row.description || image || animation
        ? {
            name: row.name,
            description: row.description,
            image,
            animation_url: animation,
          }
        : null,
    mediaHttpUrl: image ? ipfsToHttp(image) : null,
    mediaCid: extractBareCid(image),
    metadataCid: extractBareCid(row.raw_uri),
    owner: null,
  }
}
