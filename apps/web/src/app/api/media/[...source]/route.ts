import { NextResponse } from "next/server"
import { isAddress } from "viem"
import {
  getCollection,
  getCollectionCover,
  getRendererPreview,
  getRendererTokenPreview,
} from "@/lib/collection-onchain"
import { decodeInlineMedia } from "@/lib/inline-media"
import {
  getTokenImagesFromMetadata,
  isCollectionInIndexer,
} from "@/lib/indexer-queries"

export const runtime = "nodejs"

const CACHE_CONTROL =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"

function notFound() {
  return new NextResponse(null, {
    status: 404,
    headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
  })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ source: string[] }> },
) {
  const { source } = await params
  const [kind, address, tokenId, ...extra] = source
  if (extra.length > 0 || !address || !isAddress(address)) return notFound()

  let uri: string | null = null
  if (kind === "token" && tokenId && /^\d+$/.test(tokenId)) {
    const images = await getTokenImagesFromMetadata([
      { contract: address, tokenId },
    ])
    uri = images.get(`${address.toLowerCase()}:${tokenId}`) ?? null
  } else if (kind === "collection" && tokenId === undefined) {
    // Prevent arbitrary addresses from turning this image route into an
    // RPC amplifier. Only the fixed indexer's Surface set can reach coverOf.
    if ((await isCollectionInIndexer(address).catch(() => null)) !== true) {
      return notFound()
    }
    uri = (await getCollectionCover(address).catch(() => "")) || null
  } else if (
    (kind === "renderer" || kind === "preview") &&
    tokenId &&
    /^\d+$/.test(tokenId)
  ) {
    if ((await isCollectionInIndexer(address).catch(() => null)) !== true) {
      return notFound()
    }
    const collection = await getCollection(address).catch(() => null)
    if (!collection) return notFound()
    if (kind === "renderer") {
      const rendered = await getRendererTokenPreview(
        address,
        collection.renderer,
        BigInt(tokenId),
      ).catch(() => null)
      uri = rendered?.image ?? null
    } else {
      const preview = await getRendererPreview(
        address,
        collection.renderer,
        collection.minted + 1n,
        Number(tokenId),
      ).catch(() => null)
      uri = preview?.image ?? null
    }
  } else {
    return notFound()
  }

  const media = uri ? decodeInlineMedia(uri) : null
  if (!media) return notFound()

  const body = media.body.buffer.slice(
    media.body.byteOffset,
    media.body.byteOffset + media.body.byteLength,
  ) as ArrayBuffer
  return new NextResponse(body, {
    headers: {
      "Cache-Control": CACHE_CONTROL,
      "Content-Type": media.contentType,
      "Content-Length": String(media.body.byteLength),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
