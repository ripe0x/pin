import "server-only"
import { unstable_cache } from "next/cache"
import { getAuctionForToken, type AuctionState } from "./auctions"
import { getDisplayMedia, type DisplayMedia } from "./display-media"
import { readEnsIdentities } from "./ens-identity-store"
import { getActivePndAuctions, getTokenMediaFromMetadata } from "./indexer-queries"

/**
 * View model for the landing auction shelf. JSON-safe so the shelf caches
 * as one entry: three Postgres reads per rebuild, none per request.
 */
export type AuctionShelfCard = {
  house: string
  auctionId: string
  /** NFT contract address; the token page lives at `/<tokenContract>/<tokenId>`. */
  tokenContract: string
  tokenId: string
  title: string | null
  /** Seller address, for the byline avatar fallback (zorb). */
  seller: string
  /** ENS name when resolved, else a truncated address. */
  sellerLabel: string
  /** ENS avatar URL when set, else null (byline falls back to a zorb). */
  sellerAvatarUrl: string | null
  hasBid: boolean
  /** Wei as a decimal string: the current bid when there is one, else the reserve. */
  priceWei: string
  /** Unix seconds; 0 until the first bid starts the clock. */
  endTime: number
  /** Edition count for ERC1155 lots, "1" otherwise. */
  quantity: string
  artwork: DisplayMedia
}

type ActiveAuction = NonNullable<
  Awaited<ReturnType<typeof getActivePndAuctions>>
>[number]

const MAX_ITEMS = 6
// Pull a wider pool than we render so one seller with many open lots does
// not fill the shelf; we round-robin by seller down to MAX_ITEMS below.
const CANDIDATE_POOL = 36
// Upper bound for the full open-auctions listing. PND has far fewer than
// this open at once; add cursor paging here if that ever stops holding.
// ponytail: single-page cap, add paging when open count approaches it.
const ALL_OPEN_LIMIT = 200

/** Enrich raw active auctions with artwork + title into JSON-safe cards. */
async function toShelfCards(live: ActiveAuction[]): Promise<AuctionShelfCard[]> {
  const refs = live.map((a) => ({ contract: a.tokenContract, tokenId: a.tokenId }))
  const [artwork, meta, identities] = await Promise.all([
    getDisplayMedia(refs).catch(() => new Map<string, DisplayMedia>()),
    getTokenMediaFromMetadata(refs).catch(() => new Map()),
    readEnsIdentities(live.map((a) => a.seller)).catch(() => new Map()),
  ])
  return live.map((a) => {
    const key = `${a.tokenContract.toLowerCase()}:${a.tokenId}`
    const hasBid = a.firstBidTime > 0
    const identity = identities.get(a.seller.toLowerCase())
    return {
      house: a.house,
      auctionId: a.auctionId,
      tokenContract: a.tokenContract,
      tokenId: a.tokenId,
      title: meta.get(key)?.name ?? null,
      seller: a.seller,
      sellerLabel:
        identity?.ensName ?? `${a.seller.slice(0, 6)}…${a.seller.slice(-4)}`,
      sellerAvatarUrl: identity?.avatarUrl ?? null,
      hasBid,
      priceWei: (hasBid ? a.amount : a.reservePrice).toString(),
      endTime: a.endTime,
      quantity: a.tokenStandard === "erc1155" ? a.quantity.toString() : "1",
      artwork: artwork.get(key) ?? { kind: "none" },
    }
  })
}

const isOpen = (a: ActiveAuction, now: number) =>
  a.endTime === 0 || a.endTime > now

async function buildAuctionShelf(): Promise<AuctionShelfCard[]> {
  const auctions = await getActivePndAuctions(CANDIDATE_POOL)
  if (auctions === null) throw new Error("auction index unavailable")
  const now = Math.floor(Date.now() / 1000)
  const open = auctions.filter((a) => isOpen(a, now))
  // A running clock (endTime > 0) means a bid has landed; those lots are all
  // worth showing, so never let the per-seller round-robin drop a bidding lot
  // in favour of a still-unbid one. Keep every bidding lot in soonest-ending
  // order, then distribute only the not-yet-bid lots across sellers.
  const bidding = open.filter((a) => a.endTime > 0)
  const awaitingBid = distributeBySeller(open.filter((a) => a.endTime === 0))
  // One spare beyond MAX_ITEMS: the venue hero claims the top live lot, and
  // AvailableNow drops it, so the spare keeps the shelf at MAX_ITEMS.
  return toShelfCards([...bidding, ...awaitingBid].slice(0, MAX_ITEMS + 1))
}

async function buildOpenAuctions(): Promise<AuctionShelfCard[]> {
  const auctions = await getActivePndAuctions(ALL_OPEN_LIMIT)
  if (auctions === null) throw new Error("auction index unavailable")
  const now = Math.floor(Date.now() / 1000)
  // Keep the query's soonest-ending order; the full listing is a browse
  // surface, not the curated home shelf, so no per-seller round-robin.
  return toShelfCards(auctions.filter((a) => isOpen(a, now)))
}

/**
 * Round-robin auctions across sellers, preserving each seller's own order
 * (they arrive sorted soonest-ending first). One pass takes each seller's
 * next lot in first-appearance order, so the head of the shelf shows as many
 * distinct artists as there are, and a single busy seller only fills later
 * slots once everyone else is exhausted.
 */
function distributeBySeller<T extends { seller: string }>(items: T[]): T[] {
  const bySeller = new Map<string, T[]>()
  for (const item of items) {
    const key = item.seller.toLowerCase()
    const queue = bySeller.get(key)
    if (queue) queue.push(item)
    else bySeller.set(key, [item])
  }
  const queues = [...bySeller.values()]
  const out: T[] = []
  for (let i = 0; out.length < items.length; i++) {
    for (const queue of queues) if (i < queue.length) out.push(queue[i])
  }
  return out
}

/** Cached for 30 s across requests; a failed build is not cached. */
export const getAuctionShelf = unstable_cache(buildAuctionShelf, ["landing-auctions-v1"], {
  revalidate: 30,
  tags: ["landing-auctions"],
})

/** Every open PND auction, soonest-ending first. Cached 30 s across requests. */
export const getOpenAuctions = unstable_cache(buildOpenAuctions, ["open-auctions-v1"], {
  revalidate: 30,
  tags: ["landing-auctions"],
})

/**
 * The top live auction for the landing hero: the soonest-ending lot with a
 * running clock (a bid has landed), paired with its full AuctionState for the
 * bid panel. Null when nothing is actively bidding. Composes the cached shelf
 * with the pgCached per-token auction read, so it adds no fresh query. Not
 * itself unstable_cache'd: AuctionState carries bigints and is not JSON-safe.
 */
export async function getFeaturedAuction(): Promise<
  { card: AuctionShelfCard; auction: AuctionState } | null
> {
  const shelf = await getAuctionShelf().catch(() => null)
  if (!shelf) return null
  const now = Math.floor(Date.now() / 1000)
  const top = shelf.find((c) => c.endTime > now)
  if (!top) return null
  const auction = await getAuctionForToken(top.tokenContract, top.tokenId).catch(
    () => null,
  )
  return auction ? { card: top, auction } : null
}
