/**
 * Serves the stored image of one token from token_metadata as bytes.
 * Exists so a page can reference a large inline (data:) image by URL
 * instead of embedding it in the HTML. Non-inline images redirect to
 * their gateway URL. Immutable cache headers: a stored image never
 * changes for a given (contract, tokenId).
 */
import { NextResponse } from "next/server"
import { isAddress } from "viem"
import { ipfsToHttp } from "@pin/shared"
import { readTokenMetadata } from "@/lib/token-metadata-store"

const TOKEN_ID = /^\d{1,78}$/
const DATA_URI = /^data:([^;,]+)(;base64)?,(.*)$/s

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string; tokenId: string }> },
) {
  const { address, tokenId } = await params
  if (!isAddress(address) || !TOKEN_ID.test(tokenId)) {
    return NextResponse.json({ error: "Bad token." }, { status: 400 })
  }
  const meta = await readTokenMetadata(address, tokenId).catch(() => null)
  const image = meta?.imageUrl
  if (!image) return NextResponse.json({ error: "No image." }, { status: 404 })

  const inline = DATA_URI.exec(image)
  if (!inline) {
    return NextResponse.redirect(ipfsToHttp(image), {
      status: 302,
      headers: { "Cache-Control": "public, max-age=3600" },
    })
  }
  const [, mime, base64, payload] = inline
  const body = base64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8")
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
