const ALLOWED_MEDIA_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
])

const MAX_INLINE_MEDIA_BYTES = 5 * 1024 * 1024

export type DecodedInlineMedia = {
  body: Uint8Array
  contentType: string
}

/** Decode only browser-safe image data URIs and cap memory amplification. */
export function decodeInlineMedia(uri: string): DecodedInlineMedia | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(uri)
  if (!match) return null

  const contentType = match[1].toLowerCase()
  if (!ALLOWED_MEDIA_TYPES.has(contentType)) return null

  try {
    const body = match[2]
      ? Uint8Array.from(Buffer.from(match[3], "base64"))
      : Uint8Array.from(Buffer.from(decodeURIComponent(match[3]), "utf8"))
    if (body.byteLength === 0 || body.byteLength > MAX_INLINE_MEDIA_BYTES) {
      return null
    }
    return { body, contentType }
  } catch {
    return null
  }
}
