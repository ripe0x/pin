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
