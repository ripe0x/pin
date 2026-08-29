import { ipfsToHttp } from "@pin/shared"

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

/**
 * Feed pages are serialized into HTML and JSON. Embedding an onchain data URI
 * there duplicates the entire asset in every response. Point inline media at
 * the compact, CDN-cacheable media route instead.
 */
export function mediaForActivityFeed(
  uri: string | null | undefined,
  inlineUrl?: string | null,
): {
  mediaUrl: string | null
  isVideo: boolean
} {
  const trimmed = uri?.trim()
  if (!trimmed) {
    return { mediaUrl: null, isVideo: false }
  }

  if (trimmed.toLowerCase().startsWith("data:")) {
    return { mediaUrl: inlineUrl ?? null, isVideo: false }
  }

  const mediaUrl = ipfsToHttp(trimmed)
  const pathname = mediaUrl.split("?")[0].toLowerCase()
  return {
    mediaUrl,
    isVideo: VIDEO_EXTENSIONS.some((extension) => pathname.endsWith(extension)),
  }
}
