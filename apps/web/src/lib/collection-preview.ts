/**
 * Shared previewURI decoding: a renderer's IPreviewRenderer.previewURI
 * return value, decoded into something a page can display. Used by the
 * studio create wizard's renderer check and by the collection page's
 * pre-mint hero (see getRendererSamplePreview in collection-onchain.ts).
 * Browser-safe (atob/TextDecoder, no Buffer) so it runs client- and
 * server-side alike.
 */

export type PreviewDecodeResult =
  | { kind: "html"; html: string }
  | { kind: "image"; src: string }
  | { kind: "unsupported" }

/** Decode a `data:` URI into its content type and text body. Returns null
 *  for anything that isn't a `data:` URI or fails to decode. */
function decodeDataUri(uri: string): { contentType: string; text: string } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(uri.trim())
  if (!match) return null
  const contentType = (match[1] || "text/plain").toLowerCase()
  const isBase64 = !!match[2]
  try {
    if (isBase64) {
      const binary = atob(match[3])
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
      return { contentType, text: new TextDecoder().decode(bytes) }
    }
    return { contentType, text: decodeURIComponent(match[3]) }
  } catch {
    return null
  }
}

/**
 * Decode a renderer's `previewURI` return value into an HTML document
 * (sandboxed iframe srcdoc), an image (img src), or unsupported (the
 * renderer returned something that isn't a data URI, or JSON with no
 * image/animation_url field). Mirrors tokenURI output shape:
 * `data:application/json;base64,<...>` with `image` and/or
 * `animation_url` fields; `animation_url` wins when it decodes to inline
 * HTML.
 */
export function decodePreviewURI(uri: string): PreviewDecodeResult {
  const outer = decodeDataUri(uri)
  if (!outer) return { kind: "unsupported" }
  if (outer.contentType.startsWith("image/")) return { kind: "image", src: uri }
  if (!outer.contentType.includes("json")) return { kind: "unsupported" }

  let meta: { image?: unknown; animation_url?: unknown }
  try {
    meta = JSON.parse(outer.text)
  } catch {
    return { kind: "unsupported" }
  }

  const animation = typeof meta.animation_url === "string" ? meta.animation_url.trim() : ""
  if (animation) {
    const inner = decodeDataUri(animation)
    if (inner && inner.contentType.includes("html")) return { kind: "html", html: inner.text }
  }

  const image = typeof meta.image === "string" ? meta.image.trim() : ""
  if (image) return { kind: "image", src: image }

  return { kind: "unsupported" }
}
