import { arweaveToHttp, ipfsToHttp } from "@pin/shared"
import type { MediaRecord } from "./record.ts"
import { isVideoUrl } from "./media-url.ts"

export type DisplayMedia =
  | { kind: "image"; src: string; width: number | null; height: number | null }
  | {
      kind: "video"
      src: string
      poster: string | null
      width: number | null
      height: number | null
    }
  | { kind: "none" }

/** The two URI fields a token's metadata carries art in. */
export type DisplayMediaMeta = { imageUrl: string | null; animationUrl: string | null }

export type DisplayRef = { contract: string; tokenId: string }

export type ChooseDisplayMediaOptions = {
  /** Builds the URL that serves an inline `data:` image outside page HTML. */
  inlineUrl: (ref: DisplayRef) => string
}


/** Resolve an `ar://` or `ipfs://` metadata URI to an https gateway URL. */
function resolveRemoteUri(uri: string): string {
  if (uri.startsWith("ar://")) return arweaveToHttp(uri)
  return ipfsToHttp(uri)
}

/**
 * Picks what to render for one token: a ready delivery record first, else
 * the metadata's image or animation URL, else nothing. Pure and
 * synchronous, so a caller can unit-test it without a store or database.
 */
export function chooseDisplayMedia(
  meta: DisplayMediaMeta | null,
  record: MediaRecord | null,
  ref: DisplayRef,
  opts: ChooseDisplayMediaOptions,
): DisplayMedia {
  if (record?.status === "ready") {
    if (record.kind === "video" && record.posterUrl) {
      return {
        kind: "video",
        src: record.resolvedUrl ?? resolveRemoteUri(record.sourceUrl),
        poster: record.posterUrl,
        width: record.width,
        height: record.height,
      }
    }
    if (record.kind !== "video" && record.thumbnailUrl) {
      return {
        kind: "image",
        src: record.thumbnailUrl,
        width: record.width,
        height: record.height,
      }
    }
  }

  const uri = meta?.imageUrl || meta?.animationUrl || null
  if (!uri) return { kind: "none" }
  const trimmed = uri.trim()
  const lower = trimmed.toLowerCase()
  // A record that probed the source as video settles the kind before a
  // poster exists, so an extension-less URL is never rendered as an image
  // first.
  const knownVideo = record?.kind === "video"

  if (lower.startsWith("data:")) {
    const mime = lower.slice("data:".length).split(/[;,]/, 1)[0]
    // No still frame for a non-image data URI (an inline generative HTML
    // tokenURI, for example).
    if (!mime.startsWith("image/")) return { kind: "none" }
    return { kind: "image", src: opts.inlineUrl(ref), width: null, height: null }
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
