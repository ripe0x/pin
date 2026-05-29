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
 * state (token_metadata is pre-warmed by `worker warm-metadata task`,
 * ENS/EFP via pgCache).
 */

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/**
 * Events where the counterparty is the headline actor (not the artist), so
 * we resolve its identity. Bid events: the bidder ("<bidder.eth> bid 0.1 ETH
 * on <token> by <artist.eth>"). Mint open-editions: the collector who minted
 * ("<minter.eth> minted <token> by <artist.eth>"). Foundation 1/1 mints carry
 * no counterparty, so they fall back to the artist-as-subject template.
 */
const COUNTERPARTY_ACTOR_KINDS = new Set<ActivityEvent["kind"]>([
  "auction.firstBid",
  "auction.bid",
  "mint",
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
    if (COUNTERPARTY_ACTOR_KINDS.has(e.kind) && e.counterparty) {
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
        COUNTERPARTY_ACTOR_KINDS.has(event.kind) && event.counterparty
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
