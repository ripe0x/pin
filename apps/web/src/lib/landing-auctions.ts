import "server-only"
import { unstable_cache } from "next/cache"
import { getDisplayMedia, type DisplayMedia } from "./display-media"
import { getActivePndAuctions, getTokenMediaFromMetadata } from "./indexer-queries"

/**
 * View model for the landing auction shelf. JSON-safe so the shelf caches
 * as one entry: three Postgres reads per rebuild, none per request.
 */
export type AuctionShelfCard = {
  house: string
  auctionId: string
  tokenId: string
  title: string | null
  sellerLabel: string
  hasBid: boolean
  /** Wei as a decimal string: the current bid when there is one, else the reserve. */
  priceWei: string
  /** Unix seconds; 0 until the first bid starts the clock. */
  endTime: number
  /** Edition count for ERC1155 lots, "1" otherwise. */
  quantity: string
  artwork: DisplayMedia
}

const MAX_ITEMS = 6

async function buildAuctionShelf(): Promise<AuctionShelfCard[]> {
  const auctions = await getActivePndAuctions(MAX_ITEMS)
  if (auctions === null) throw new Error("auction index unavailable")
  const now = Math.floor(Date.now() / 1000)
  const live = auctions.filter((a) => a.endTime === 0 || a.endTime > now)
  const refs = live.map((a) => ({ contract: a.tokenContract, tokenId: a.tokenId }))
  const [artwork, meta] = await Promise.all([
    getDisplayMedia(refs).catch(() => new Map<string, DisplayMedia>()),
    getTokenMediaFromMetadata(refs).catch(() => new Map()),
  ])
  return live.map((a) => {
    const key = `${a.tokenContract.toLowerCase()}:${a.tokenId}`
    const hasBid = a.firstBidTime > 0
    return {
      house: a.house,
      auctionId: a.auctionId,
      tokenId: a.tokenId,
      title: meta.get(key)?.name ?? null,
      sellerLabel: `${a.seller.slice(0, 6)}…${a.seller.slice(-4)}`,
      hasBid,
      priceWei: (hasBid ? a.amount : a.reservePrice).toString(),
      endTime: a.endTime,
      quantity: a.tokenStandard === "erc1155" ? a.quantity.toString() : "1",
      artwork: artwork.get(key) ?? { kind: "none" },
    }
  })
}

/** Cached for 30 s across requests; a failed build is not cached. */
export const getAuctionShelf = unstable_cache(buildAuctionShelf, ["landing-auctions-v1"], {
  revalidate: 30,
  tags: ["landing-auctions"],
})
