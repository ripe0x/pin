import type { ActivityEvent } from "./indexer-queries"

/**
 * Wire shape + (de)serializers for the v2 activity feed.
 *
 * Lives in a server-only-free module so the client component (which
 * decodes the API response) can import the types without dragging the
 * server-only enrichment helpers into the browser bundle.
 */

export type EnrichedActivityEvent = ActivityEvent & {
  artistDisplayName: string
  artistAvatarUrl: string | null
  /**
   * Display name + avatar for `event.counterparty` — only populated for
   * events where the counterparty is the actor (bid events). Other event
   * kinds carry the raw address in `counterparty` and don't need a
   * display name; the row template renders them as truncated addresses.
   */
  counterpartyDisplayName: string | null
  counterpartyAvatarUrl: string | null
  tokenTitle: string | null
  mediaUrl: string | null
  isVideo: boolean
}

export type SerializedActivityEvent = Omit<
  EnrichedActivityEvent,
  "amountWei" | "reserveWei"
> & {
  amountWei: string | null
  reserveWei: string | null
}

export function serializeForWire(
  event: EnrichedActivityEvent,
): SerializedActivityEvent {
  return {
    ...event,
    amountWei: event.amountWei === null ? null : event.amountWei.toString(),
    reserveWei: event.reserveWei === null ? null : event.reserveWei.toString(),
  }
}

export function deserializeFromWire(
  event: SerializedActivityEvent,
): EnrichedActivityEvent {
  return {
    ...event,
    amountWei: event.amountWei === null ? null : BigInt(event.amountWei),
    reserveWei: event.reserveWei === null ? null : BigInt(event.reserveWei),
  }
}

// ── Feed items: single events + collapsed mint runs ─────────────────────
//
// The feed's unit is a FeedItem: either one enriched event or a group row
// standing for a run of mints (see lib/activity-grouping.ts for the
// collapse rule). A group carries only what its row renders plus the two
// timestamps the client needs to keep merging across page boundaries —
// not its member events, so a hundred-mint run costs one row of payload.

export type MinterRef = {
  address: string
  displayName: string | null
  avatarUrl: string | null
}

export type EnrichedMintGroup = {
  type: "group"
  /** The newest member's event id — stable across refetches. */
  id: string
  /** Group key: `${contract}:${artist}` lowercased. */
  key: string
  /** Newest member's blockTime; the group sorts and dates by it. */
  blockTime: number
  /** Oldest member's blockTime; drives the "over Xm" span and the
   * page-boundary gap check. */
  oldestBlockTime: number
  artist: string
  artistDisplayName: string
  artistAvatarUrl: string | null
  tokenContract: string
  collection: string | null
  collectionName: string | null
  /** Number of mint events collapsed into this row. */
  mintCount: number
  /** Tokens issued (sum of per-event quantity). */
  tokenCount: number
  /** Sum of the members' sale amounts; null when none carried one. */
  totalWei: bigint | null
  /** Up to a few distinct minters, newest first, for the avatar sample. */
  minters: MinterRef[]
  mediaUrl: string | null
  isVideo: boolean
}

export type EnrichedFeedItem =
  | { type: "event"; event: EnrichedActivityEvent }
  | EnrichedMintGroup

export type SerializedMintGroup = Omit<EnrichedMintGroup, "totalWei"> & {
  totalWei: string | null
}

export type SerializedFeedItem =
  | { type: "event"; event: SerializedActivityEvent }
  | SerializedMintGroup

export function serializeFeedItem(item: EnrichedFeedItem): SerializedFeedItem {
  if (item.type === "event") {
    return { type: "event", event: serializeForWire(item.event) }
  }
  return {
    ...item,
    totalWei: item.totalWei === null ? null : item.totalWei.toString(),
  }
}

export function deserializeFeedItem(
  item: SerializedFeedItem,
): EnrichedFeedItem {
  if (item.type === "event") {
    return { type: "event", event: deserializeFromWire(item.event) }
  }
  return {
    ...item,
    totalWei: item.totalWei === null ? null : BigInt(item.totalWei),
  }
}
