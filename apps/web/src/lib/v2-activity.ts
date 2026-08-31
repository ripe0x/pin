import "server-only"
import { readEnsIdentities } from "./ens-identity-store"
import {
  getActivityTokenMetadata,
  type ActivityEvent,
  type ActivityTokenMetadata,
} from "./indexer-queries"
import { getMediaDeliveries, type MediaDelivery } from "./media-delivery"
import { mediaForActivityFeed } from "./activity-media"
import {
  GROUP_MINTER_SAMPLE,
  groupFeedEvents,
  mintGroupKey,
  tokenCountOf,
} from "./activity-grouping"
import type {
  EnrichedActivityEvent,
  EnrichedFeedItem,
  EnrichedMintGroup,
  MinterRef,
} from "./v2-activity-types"

export type { EnrichedActivityEvent } from "./v2-activity-types"
export {
  serializeForWire,
  deserializeFromWire,
  serializeFeedItem,
  deserializeFeedItem,
  type SerializedActivityEvent,
  type SerializedFeedItem,
} from "./v2-activity-types"

/**
 * Server-only, Postgres-only enrichment for the activity feed. Rendering a
 * page never resolves ENS, tokenURI, collection covers, or remote media.
 * Worker-prewarmed rows are used when present; honest address and no-media
 * fallbacks are used while enrichment catches up.
 */

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/**
 * Events where the counterparty is the headline actor (not the artist), so
 * we resolve its identity. Bid events: the bidder ("<bidder.eth> bid 0.1 ETH
 * on <token> by <artist.eth>"). Mint open-editions and Surface mints: the
 * collector who minted ("<minter.eth> minted <token> by <artist.eth>").
 * Foundation 1/1 mints carry no counterparty, so they fall back to the
 * artist-as-subject template.
 */
const COUNTERPARTY_ACTOR_KINDS = new Set<ActivityEvent["kind"]>([
  "auction.firstBid",
  "auction.bid",
  "mint",
])

type Identity = { displayName: string; avatarUrl: string | null } | null

/** Hard ceiling even when the API accepts a 100-event page. */
export const MAX_ACTIVITY_IDENTITIES = 32

export async function enrichFeedPage(
  events: ActivityEvent[],
): Promise<EnrichedFeedItem[]> {
  const items = groupFeedEvents(events)

  const addressPool = new Set<string>()
  const addIdentity = (address: string | null) => {
    if (!address || addressPool.size >= MAX_ACTIVITY_IDENTITIES) return
    addressPool.add(address.toLowerCase())
  }

  // Artists are required to read every row, so they receive the bounded
  // identity slots before optional bidder/minter enrichment.
  for (const item of items) {
    if (item.type === "event") {
      addIdentity(item.event.artist)
    } else {
      addIdentity(item.events[0].artist)
    }
  }
  for (const item of items) {
    if (item.type === "event") {
      if (COUNTERPARTY_ACTOR_KINDS.has(item.event.kind)) {
        addIdentity(item.event.counterparty)
      }
    } else {
      for (const addr of sampleMinters(item.events)) {
        addIdentity(addr)
      }
    }
  }

  const storedIdentities = await readEnsIdentities(Array.from(addressPool))
  const identities = new Map<string, Identity>()
  for (const address of addressPool) {
    const stored = storedIdentities.get(address)
    identities.set(
      address,
      stored
        ? {
            displayName: stored.ensName ?? truncateAddress(address),
            avatarUrl: stored.avatarUrl,
          }
        : null,
    )
  }

  const tokenPairs = new Map<string, { contract: string; tokenId: string }>()
  for (const item of items) {
    const events = item.type === "event" ? [item.event] : item.events
    for (const e of events) {
      if (e.tokenContract && e.tokenId) {
        tokenPairs.set(tokenMediaKey(e.tokenContract, e.tokenId), {
          contract: e.tokenContract,
          tokenId: e.tokenId,
        })
      }
    }
  }
  const pairs = Array.from(tokenPairs.values())
  const [metadata, deliveries] = await Promise.all([
    getActivityTokenMetadata(pairs).catch(
      () => new Map<string, ActivityTokenMetadata>(),
    ),
    getMediaDeliveries(pairs).catch(() => new Map<string, MediaDelivery>()),
  ])

  return items.map((item) =>
    item.type === "event"
      ? {
          type: "event" as const,
          event: enrichEvent(item.event, identities, metadata, deliveries),
        }
      : enrichRun(item.events, identities, metadata, deliveries),
  )
}

function tokenMediaKey(contract: string, tokenId: string): string {
  return `${contract.toLowerCase()}:${tokenId}`
}

function storedMedia(
  event: ActivityEvent,
  metadata: Map<string, ActivityTokenMetadata>,
  deliveries: Map<string, MediaDelivery>,
): { uri: string | null; inlineUrl: string | null } {
  if (!event.tokenContract || !event.tokenId) {
    return { uri: null, inlineUrl: null }
  }
  const key = tokenMediaKey(event.tokenContract, event.tokenId)
  const meta = metadata.get(key)
  const delivery = deliveries.get(key)
  const uri =
    delivery?.status === "ready"
      ? delivery.thumbnailUrl ?? delivery.posterUrl ?? meta?.imageUrl ?? null
      : meta?.imageUrl ?? meta?.animationUrl ?? null
  return {
    uri,
    inlineUrl: uri?.trim().toLowerCase().startsWith("data:")
      ? tokenMediaUrl(event.tokenContract, event.tokenId)
      : null,
  }
}

function tokenMediaUrl(contract: string, tokenId: string): string {
  return `/api/media/token/${encodeURIComponent(contract)}/${encodeURIComponent(tokenId)}`
}

/** First few distinct counterparty addresses of a run, newest-first. */
function sampleMinters(events: ActivityEvent[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of events) {
    if (!e.counterparty) continue
    const addr = e.counterparty.toLowerCase()
    if (seen.has(addr)) continue
    seen.add(addr)
    out.push(addr)
    if (out.length >= GROUP_MINTER_SAMPLE) break
  }
  return out
}

function enrichEvent(
  event: ActivityEvent,
  identities: Map<string, Identity>,
  metadata: Map<string, ActivityTokenMetadata>,
  deliveries: Map<string, MediaDelivery>,
): EnrichedActivityEvent {
  const meta =
    event.tokenContract && event.tokenId
      ? metadata.get(tokenMediaKey(event.tokenContract, event.tokenId))
      : null
  const tokenTitle = event.tokenId
    ? meta?.name && meta.name !== `#${event.tokenId}`
      ? meta.name
      : event.collectionName
        ? `${event.collectionName} #${event.tokenId}`
        : `#${event.tokenId}`
    : null
  const source = storedMedia(event, metadata, deliveries)
  const { mediaUrl, isVideo } = mediaForActivityFeed(
    source.uri,
    source.inlineUrl,
  )

  const artistId = identities.get(event.artist.toLowerCase())

  const counterpartyId =
    COUNTERPARTY_ACTOR_KINDS.has(event.kind) && event.counterparty
      ? identities.get(event.counterparty.toLowerCase())
      : null

  return {
    ...event,
    artistDisplayName: artistId?.displayName ?? truncateAddress(event.artist),
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
}

/** Enrich a mint bucket into one row using only materialized media. */
function enrichRun(
  events: ActivityEvent[],
  identities: Map<string, Identity>,
  metadata: Map<string, ActivityTokenMetadata>,
  deliveries: Map<string, MediaDelivery>,
): EnrichedMintGroup {
  const newest = events[0]
  const oldest = events[events.length - 1]
  const artistId = identities.get(newest.artist.toLowerCase())

  const withMedia =
    events.find((event) => storedMedia(event, metadata, deliveries).uri) ?? newest
  const source = storedMedia(withMedia, metadata, deliveries)
  const media = mediaForActivityFeed(source.uri, source.inlineUrl)

  const minters: MinterRef[] = sampleMinters(events).map((addr) => {
    const id = identities.get(addr)
    return {
      address: addr,
      displayName: id?.displayName ?? null,
      avatarUrl: id?.avatarUrl ?? null,
    }
  })

  return {
    type: "group",
    id: newest.id,
    key: mintGroupKey(newest)!,
    blockTime: newest.blockTime,
    oldestBlockTime: oldest.blockTime,
    artist: newest.artist,
    artistDisplayName: artistId?.displayName ?? truncateAddress(newest.artist),
    artistAvatarUrl: artistId?.avatarUrl ?? null,
    tokenContract: newest.tokenContract!,
    collection: newest.collection,
    collectionName: newest.collectionName,
    mintCount: events.length,
    tokenCount: tokenCountOf(events),
    totalWei: events.reduce<bigint | null>((sum, e) => {
      if (e.amountWei === null) return sum
      return sum === null ? e.amountWei : sum + e.amountWei
    }, null),
    minters,
    mediaUrl: media.mediaUrl,
    isVideo: media.isVideo,
  }
}
