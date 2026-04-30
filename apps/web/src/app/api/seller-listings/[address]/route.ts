import { NextResponse } from "next/server"
import { unstable_cache } from "next/cache"
import { pgCache } from "@/lib/pg-cache"
import { getSellerCancellableListings } from "@/lib/seller-listings"
import {
  readFoundationSellerListings,
  writeFoundationSellerListings,
  LAZY_TTL,
  isFresh,
} from "@/lib/lazy-index"

/**
 * Wraps `getSellerCancellableListings` (two ~10M-block `getLogs` + multicalls
 * per cold call) in unstable_cache + pgCache so repeat panel opens by the
 * same artist (and across artists who share a worker) collapse to a Postgres
 * read. The lib function is unchanged so the API route just delegates.
 *
 * Bigints are serialized to decimal strings at the cache + JSON boundary
 * because pgCache JSON-stringifies and `JSON.stringify(bigint)` throws.
 */

type SerializedAuction = {
  kind: "auction"
  id: string
  auctionId: string
  nftContract: string
  tokenId: string
  reserveWei: string
  durationSeconds: number
}

type SerializedBuyNow = {
  kind: "buyNow"
  id: string
  nftContract: string
  tokenId: string
  priceWei: string
}

export type SellerListingsPayload = {
  auctions: SerializedAuction[]
  buyNows: SerializedBuyNow[]
}

const SELLER_LISTINGS_TTL_S = 5 * 60

async function buildPayload(
  sellerAddress: string,
): Promise<SellerListingsPayload> {
  // Lazy index read: if a fresh row exists, return it without RPC.
  const cached = await readFoundationSellerListings(sellerAddress)
  if (cached && isFresh(cached.lastIndexedAt, LAZY_TTL.foundationSellerListings)) {
    return {
      auctions: cached.auctions.map((a) => ({ ...a, kind: "auction" as const })),
      buyNows: cached.buyNows.map((b) => ({ ...b, kind: "buyNow" as const })),
    }
  }

  const { auctions, buyNows } = await getSellerCancellableListings(sellerAddress)
  const payload: SellerListingsPayload = {
    auctions: auctions.map((a) => ({
      kind: "auction" as const,
      id: a.id,
      auctionId: a.auctionId.toString(),
      nftContract: a.nftContract,
      tokenId: a.tokenId,
      reserveWei: a.reserveWei.toString(),
      durationSeconds: a.durationSeconds,
    })),
    buyNows: buyNows.map((b) => ({
      kind: "buyNow" as const,
      id: b.id,
      nftContract: b.nftContract,
      tokenId: b.tokenId,
      priceWei: b.priceWei.toString(),
    })),
  }
  // Fire-and-forget — next miss within 5 min hits Postgres only.
  writeFoundationSellerListings(sellerAddress, payload)
  return payload
}

const cached = unstable_cache(
  (sellerAddress: string) =>
    pgCache<SellerListingsPayload>(
      `seller-listings:${sellerAddress}`,
      SELLER_LISTINGS_TTL_S,
      () => buildPayload(sellerAddress),
    ),
  ["seller-listings-v1"],
  { revalidate: SELLER_LISTINGS_TTL_S, tags: ["seller-listings"] },
)

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse<SellerListingsPayload | { error: string }>> {
  const { address } = await ctx.params
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 })
  }
  const data = await cached(address.toLowerCase())
  return NextResponse.json(data)
}
