import "server-only"
import { ipfsToHttp } from "@pin/shared"
import { resolveTokenMetadataDirect } from "./onchain-discovery"
import { getArtistIdentity } from "./artist-queries"
import { getCollectionCover } from "./collection-onchain"
import { getTokenImagesFromMetadata, type ActivityEvent } from "./indexer-queries"
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
 * Server-only enrichment for the v2 activity feed. Raw indexer events are
 * first collapsed into feed items (mint runs group, everything else stays
 * a single row — lib/activity-grouping.ts), then resolved: identities in
 * one batch, token metadata / collection covers as Postgres-cached point
 * reads.
 *
 * Grouping BEFORE enrichment is the cost control: a hundred-mint drop
 * enriches one group row (artist + a minter sample + one media lookup),
 * not a hundred token reads.
 *
 * Surface rows (kind "mint" or "collection.deployed" with `collection`
 * set) never resolve tokenURI at render time — a generative tokenURI is a
 * full HTML document. Their name comes from the indexed row
 * (SurfaceCreated carries it). Their thumbnail is the worker-warmed
 * per-token image from token_metadata when present (an onchain-SVG work's
 * small `image` field), falling back to the collection cover, then the
 * actor's avatar/zorb — all Postgres reads, no chain call.
 */

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

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

/** Surface events carry `collection`; their media is the collection cover
 * and their metadata never comes from tokenURI. */
function isSurfaceEvent(event: ActivityEvent): boolean {
  return (
    event.collection !== null &&
    (event.kind === "mint" || event.kind === "collection.deployed")
  )
}

function mediaFromUri(uri: string | null | undefined): {
  mediaUrl: string | null
  isVideo: boolean
} {
  const mediaUrl = uri ? ipfsToHttp(uri) : null
  const isVideo = mediaUrl
    ? VIDEO_EXTENSIONS.some((ext) =>
        mediaUrl.split("?")[0].toLowerCase().endsWith(ext),
      )
    : false
  return { mediaUrl, isVideo }
}

type Identity = { displayName: string; avatarUrl: string | null } | null

export async function enrichFeedPage(
  events: ActivityEvent[],
): Promise<EnrichedFeedItem[]> {
  const items = groupFeedEvents(events)

  // ── Identity batch ──
  // Artists of every item; counterparties for single actor-kind events;
  // for runs, only the first few distinct minters (the avatar sample).
  const addressPool = new Set<string>()
  for (const item of items) {
    if (item.type === "event") {
      const e = item.event
      addressPool.add(e.artist.toLowerCase())
      if (COUNTERPARTY_ACTOR_KINDS.has(e.kind) && e.counterparty) {
        addressPool.add(e.counterparty.toLowerCase())
      }
    } else {
      addressPool.add(item.events[0].artist.toLowerCase())
      for (const addr of sampleMinters(item.events)) {
        addressPool.add(addr)
      }
    }
  }

  const identities = new Map<string, Identity>(
    await Promise.all(
      Array.from(addressPool).map(
        async (addr) =>
          [addr, await getArtistIdentity(addr).catch(() => null)] as const,
      ),
    ),
  )

  // ── Collection covers ──
  // One cached read per distinct Surface collection on the page.
  const coverPool = new Set<string>()
  for (const item of items) {
    const events = item.type === "event" ? [item.event] : [item.events[0]]
    for (const e of events) {
      if (isSurfaceEvent(e) && e.collection) {
        coverPool.add(e.collection.toLowerCase())
      }
    }
  }
  const covers = new Map<string, string>(
    await Promise.all(
      Array.from(coverPool).map(
        async (addr) =>
          [
            addr,
            await getCollectionCover(addr as `0x${string}`).catch(() => ""),
          ] as const,
      ),
    ),
  )

  // ── Surface per-token images ──
  // One Postgres read for the Surface mint tokens on the page. A hit
  // (the worker warmed the token's onchain image) beats the collection
  // cover; a miss falls through to the cover. Never a chain read here.
  const surfacePairs = new Map<string, { contract: string; tokenId: string }>()
  for (const item of items) {
    const events = item.type === "event" ? [item.event] : item.events
    for (const e of events) {
      if (isSurfaceEvent(e) && e.tokenContract && e.tokenId) {
        surfacePairs.set(surfaceImageKey(e.tokenContract, e.tokenId), {
          contract: e.tokenContract,
          tokenId: e.tokenId,
        })
      }
    }
  }
  const surfaceImages = await getTokenImagesFromMetadata(
    Array.from(surfacePairs.values()),
  ).catch(() => new Map<string, string>())

  return Promise.all(
    items.map(async (item) =>
      item.type === "event"
        ? {
            type: "event" as const,
            event: await enrichEvent(item.event, identities, covers, surfaceImages),
          }
        : enrichRun(item.events, identities, covers, surfaceImages),
    ),
  )
}

/** Key for the Surface per-token image map: `${contract}:${tokenId}`,
 * contract lowercased (token ids are decimal strings, case-stable). */
function surfaceImageKey(contract: string, tokenId: string): string {
  return `${contract.toLowerCase()}:${tokenId}`
}

/** The media URI for a Surface event: the warmed per-token image if the
 * worker has one, else the collection cover (may be ""). */
function surfaceMediaUri(
  event: ActivityEvent,
  covers: Map<string, string>,
  surfaceImages: Map<string, string>,
): string | null {
  if (event.tokenContract && event.tokenId) {
    const img = surfaceImages.get(
      surfaceImageKey(event.tokenContract, event.tokenId),
    )
    if (img) return img
  }
  return covers.get(event.collection!.toLowerCase()) || null
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

async function enrichEvent(
  event: ActivityEvent,
  identities: Map<string, Identity>,
  covers: Map<string, string>,
  surfaceImages: Map<string, string>,
): Promise<EnrichedActivityEvent> {
  const surface = isSurfaceEvent(event)

  const meta =
    !surface && event.tokenContract && event.tokenId
      ? await resolveTokenMetadataDirect(
          event.tokenContract,
          event.tokenId,
        ).catch(() => null)
      : null

  const tokenTitle = surface
    ? event.tokenId
      ? event.collectionName
        ? `${event.collectionName} #${event.tokenId}`
        : `#${event.tokenId}`
      : null
    : meta?.name && meta.name !== `#${event.tokenId}`
      ? meta.name
      : event.tokenId
        ? `#${event.tokenId}`
        : null

  const { mediaUrl, isVideo } = surface
    ? mediaFromUri(surfaceMediaUri(event, covers, surfaceImages))
    : mediaFromUri(meta?.image)

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

/** Enrich a mint run into a single group row. Media: the collection cover
 * for Surface runs, the newest member's token image otherwise. */
async function enrichRun(
  events: ActivityEvent[],
  identities: Map<string, Identity>,
  covers: Map<string, string>,
  surfaceImages: Map<string, string>,
): Promise<EnrichedMintGroup> {
  const newest = events[0]
  const oldest = events[events.length - 1]
  const artistId = identities.get(newest.artist.toLowerCase())

  let media: { mediaUrl: string | null; isVideo: boolean }
  if (isSurfaceEvent(newest)) {
    // Prefer the first run member with a warmed per-token image; else
    // the collection cover. Newest-first, so this favors recent art.
    const withImg = events.find(
      (e) =>
        e.tokenContract &&
        e.tokenId &&
        surfaceImages.get(surfaceImageKey(e.tokenContract, e.tokenId)),
    )
    const uri = withImg
      ? surfaceImages.get(
          surfaceImageKey(withImg.tokenContract!, withImg.tokenId!),
        )!
      : covers.get(newest.collection!.toLowerCase()) || null
    media = mediaFromUri(uri)
  } else {
    const meta =
      newest.tokenContract && newest.tokenId
        ? await resolveTokenMetadataDirect(
            newest.tokenContract,
            newest.tokenId,
          ).catch(() => null)
        : null
    media = mediaFromUri(meta?.image)
  }

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
