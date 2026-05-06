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

/**
 * Bid events flip subject/object in the row template — the bidder is
 * the actor. Resolve their identity so the headline reads "<bidder.eth>
 * bid 0.1 ETH on <token> by <artist.eth>" instead of a truncated 0x.
 */
const BIDDER_AS_SUBJECT_KINDS = new Set<ActivityEvent["kind"]>([
  "auction.firstBid",
  "auction.bid",
])

export async function enrichActivityEvents(
  events: ActivityEvent[],
): Promise<EnrichedActivityEvent[]> {
  // Pool every address whose display name we'll render — sellers always,
  // bidders for bid events. One identity batch covers both, so a bidder
  // who is also a seller in a different row only resolves once.
  const addressPool = new Set<string>()
  for (const e of events) {
    addressPool.add(e.artist.toLowerCase())
    if (BIDDER_AS_SUBJECT_KINDS.has(e.kind) && e.counterparty) {
      addressPool.add(e.counterparty.toLowerCase())
    }
  }

  const identities = new Map(
    await Promise.all(
      Array.from(addressPool).map(
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

      const artistId = identities.get(event.artist.toLowerCase())

      const counterpartyId =
        BIDDER_AS_SUBJECT_KINDS.has(event.kind) && event.counterparty
          ? identities.get(event.counterparty.toLowerCase())
          : null

      return {
        ...event,
        artistDisplayName:
          artistId?.displayName ?? truncateAddress(event.artist),
        artistAvatarUrl: artistId?.avatarUrl ?? null,
        counterpartyDisplayName: counterpartyId
          ? (counterpartyId.displayName ??
            (event.counterparty ? truncateAddress(event.counterparty) : null))
          : null,
        counterpartyAvatarUrl: counterpartyId?.avatarUrl ?? null,
        tokenTitle,
        mediaUrl,
        isVideo,
      }
    }),
  )
}
