import "server-only"
import { ipfsToHttp } from "@pin/shared"
import { resolveTokenMetadataDirect } from "./onchain-discovery"
import { getArtistIdentity } from "./artist-queries"
import type { ActivityEvent } from "./indexer-queries"
import type { EnrichedActivityEvent } from "./v2-activity-types"

export type { EnrichedActivityEvent } from "./v2-activity-types"
export {
  serializeForWire,
  deserializeFromWire,
  type SerializedActivityEvent,
} from "./v2-activity-types"

/**
 * Server-only enrichment for v2 activity events. Resolves token
 * metadata + artist identity in parallel so the client can render rows
 * without follow-up requests. Both lookups are point-reads in steady
 * state (token_metadata is pre-warmed by `apps/metadata-warmer`,
 * ENS/EFP via pgCache).
 */

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export async function enrichActivityEvents(
  events: ActivityEvent[],
): Promise<EnrichedActivityEvent[]> {
  const uniqueArtists = Array.from(
    new Set(events.map((e) => e.artist.toLowerCase())),
  )
  const identities = new Map(
    await Promise.all(
      uniqueArtists.map(
        async (addr) =>
          [addr, await getArtistIdentity(addr).catch(() => null)] as const,
      ),
    ),
  )

  return Promise.all(
    events.map(async (event) => {
      const meta =
        event.tokenContract && event.tokenId
          ? await resolveTokenMetadataDirect(
              event.tokenContract,
              event.tokenId,
            ).catch(() => null)
          : null

      const tokenTitle =
        meta?.name && meta.name !== `#${event.tokenId}`
          ? meta.name
          : event.tokenId
            ? `#${event.tokenId}`
            : null

      const mediaUrl = meta?.image ? ipfsToHttp(meta.image) : null
      const isVideo = mediaUrl
        ? VIDEO_EXTENSIONS.some((ext) =>
            mediaUrl.split("?")[0].toLowerCase().endsWith(ext),
          )
        : false

      const id = identities.get(event.artist.toLowerCase())

      return {
        ...event,
        artistDisplayName: id?.displayName ?? truncateAddress(event.artist),
        artistAvatarUrl: id?.avatarUrl ?? null,
        tokenTitle,
        mediaUrl,
        isVideo,
      }
    }),
  )
}
