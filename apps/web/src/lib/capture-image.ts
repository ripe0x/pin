/**
 * Hosted capture images. The capture worker saves each token's deterministic
 * PNG in Postgres as soon as it renders; a collection's RenderAssets capture
 * template points every token at this route until its ar:// capture is
 * written onchain. While a PNG is pending the route redirects to the cover.
 */

export interface CaptureImagePath {
  chainId: number
  collection: string
  tokenId: string
}

/** `/api/captures/{chainId}/{collection}/{tokenId}.png`, canonical spellings only. */
export function parseCaptureImagePath(chainId: string, collection: string, file: string): CaptureImagePath | null {
  const id = /^(0|[1-9]\d{0,77})\.png$/.exec(file)
  if (!/^[1-9]\d{0,9}$/.test(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(collection) || !id) return null
  return { chainId: Number(chainId), collection: collection.toLowerCase(), tokenId: id[1] }
}

/** Cover redirect target: ar:// through the Arweave gateway, or an https URL as is. */
export function coverRedirectUrl(uri: string | null): string | null {
  if (!uri) return null
  const ar = /^ar:\/\/([A-Za-z0-9_-]{43}(?:\/[A-Za-z0-9._~%/-]*)?)$/.exec(uri)
  if (ar) return `https://arweave.net/${ar[1]}`
  try {
    return new URL(uri).protocol === "https:" ? uri : null
  } catch {
    return null
  }
}

// A rendered PNG never changes: it is a pure function of the confirmed seed.
const IMMUTABLE = "public, max-age=31536000, immutable"
// The cover stands in only until rendering finishes, usually minutes.
const PENDING = "public, max-age=60, s-maxage=60"

export function captureImageResponse(row: { png: Uint8Array | null; sha256: string | null; cover_uri: string | null } | undefined): Response {
  if (row?.png) {
    const body = row.png.buffer.slice(row.png.byteOffset, row.png.byteOffset + row.png.byteLength) as ArrayBuffer
    return new Response(body, {
      headers: {
        "Cache-Control": IMMUTABLE,
        "Netlify-CDN-Cache-Control": `${IMMUTABLE}, durable`,
        "Content-Type": "image/png",
        "Content-Length": String(row.png.byteLength),
        ...(row.sha256 ? { ETag: `"${row.sha256}"` } : {}),
        "X-Content-Type-Options": "nosniff",
      },
    })
  }
  const cover = coverRedirectUrl(row?.cover_uri ?? null)
  if (cover) return new Response(null, { status: 302, headers: { Location: cover, "Cache-Control": PENDING } })
  return new Response(null, { status: 404, headers: { "Cache-Control": PENDING } })
}
