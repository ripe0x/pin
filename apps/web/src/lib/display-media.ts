// No top-level `import "server-only"`: `chooseDisplayMedia` below is pure
// and unit-tested by the plain-Node test runner, which cannot load a
// server-only module (see indexer-freshness-status.ts for the same split).
// `getDisplayMedia` pulls in the two Postgres-backed reads with a dynamic
// import so loading this file for the pure function never touches them;
// both of those modules declare `server-only` themselves, so the actual
// database access stays server-only enforced.
import { arweaveToHttp, ipfsToHttp } from "@pin/shared"
import type { MediaDelivery } from "./media-delivery"
import type { TokenMetadataMedia } from "./indexer-queries"
import { isVideoUrl } from "./media-url"

export type DisplayMedia =
  | { kind: "image"; src: string; width: number | null; height: number | null }
  | { kind: "video"; src: string; poster: string | null; width: number | null; height: number | null }
  | { kind: "none" }

type Ref = { contract: string; tokenId: string }

function refKey(ref: Ref): string {
  return `${ref.contract.toLowerCase()}:${ref.tokenId}`
}

function tokenMediaUrl(ref: Ref): string {
  return `/api/media/token/${encodeURIComponent(ref.contract)}/${encodeURIComponent(ref.tokenId)}`
}

/** Resolve any of the metadata URI schemes this codebase serves art from
 * to an https URL. `data:` is handled by the caller before this runs. */
function resolveRemoteUri(uri: string): string {
  if (uri.startsWith("ar://")) return arweaveToHttp(uri)
  return ipfsToHttp(uri)
}

/**
 * Picks what to render for one token: a ready delivery derivative first,
 * else the metadata's image or animation URL, else nothing. Pure and
 * synchronous so it unit-tests without a database.
 */
export function chooseDisplayMedia(
  meta: Pick<TokenMetadataMedia, "imageUrl" | "animationUrl"> | null,
  delivery: MediaDelivery | null,
  ref: Ref,
): DisplayMedia {
  if (delivery?.status === "ready") {
    if (delivery.kind === "video" && delivery.posterUrl) {
      return {
        kind: "video",
        src: delivery.resolvedUrl ?? resolveRemoteUri(delivery.originalUrl),
        poster: delivery.posterUrl,
        width: delivery.width,
        height: delivery.height,
      }
    }
    if (delivery.kind !== "video" && delivery.thumbnailUrl) {
      return {
        kind: "image",
        src: delivery.thumbnailUrl,
        width: delivery.width,
        height: delivery.height,
      }
    }
  }

  const uri = meta?.imageUrl || meta?.animationUrl || null
  if (!uri) return { kind: "none" }
  const trimmed = uri.trim()
  const lower = trimmed.toLowerCase()
  // The worker probes the real content type. A record that knows the
  // source is a video settles the kind server-side even before a poster
  // exists, so an extension-less URL is never rendered as an image first.
  const knownVideo = delivery?.kind === "video"

  if (lower.startsWith("data:")) {
    const mime = lower.slice("data:".length).split(/[;,]/, 1)[0]
    // An inline HTML document (a generative tokenURI) has no still frame
    // to show as a thumbnail.
    if (!mime.startsWith("image/")) return { kind: "none" }
    return { kind: "image", src: tokenMediaUrl(ref), width: null, height: null }
  }

  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return knownVideo || isVideoUrl(trimmed)
      ? { kind: "video", src: trimmed, poster: null, width: null, height: null }
      : { kind: "image", src: trimmed, width: null, height: null }
  }

  const resolved = resolveRemoteUri(trimmed)
  return knownVideo || isVideoUrl(resolved)
    ? { kind: "video", src: resolved, poster: null, width: null, height: null }
    : { kind: "image", src: resolved, width: null, height: null }
}

/**
 * Batch resolver for a page's worth of tokens: two Postgres reads total
 * (token_metadata, token_media_delivery), no chain reads. Keyed by
 * `${contract.toLowerCase()}:${tokenId}`.
 */
export async function getDisplayMedia(refs: Ref[]): Promise<Map<string, DisplayMedia>> {
  const out = new Map<string, DisplayMedia>()
  if (refs.length === 0) return out
  const [{ getTokenMediaFromMetadata }, { getMediaDeliveries }] = await Promise.all([
    import("./indexer-queries"),
    import("./media-delivery"),
  ])
  const [metaMap, deliveryMap] = await Promise.all([
    getTokenMediaFromMetadata(refs).catch(() => new Map<string, TokenMetadataMedia>()),
    getMediaDeliveries(refs).catch(() => new Map<string, MediaDelivery>()),
  ])
  for (const ref of refs) {
    const key = refKey(ref)
    out.set(
      key,
      chooseDisplayMedia(metaMap.get(key) ?? null, deliveryMap.get(key) ?? null, ref),
    )
  }
  return out
}
