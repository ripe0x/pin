import { unstable_noStore as noStore } from "next/cache"
import { PLATFORMS, type ActiveAuctionSummary } from "@/lib/platforms"
import { getArtistIdentity } from "@/lib/artist-queries"
import { WorkArtistCard } from "./WorkArtistCard"
import { HomeHeroTile } from "./HomeHeroTile"
import { ActiveAuctionsStrip } from "./ActiveAuctionsStrip"

const HOME_GRID_SIZE = 11
// Number of work cards (excluding the hero) shown in the top half of
// the split grid. On lg the layout is 4-col so the top half = hero
// (col-span-2) + 1 card on row 1, then 2 cards on row 2 = 3 work cards.
const TOP_HALF_WORK_CARDS = 3

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/**
 * The home page itself — a single composition: a wall of cards where the
 * top-left cell is editorial (the hero) and the rest are "work + artist"
 * pairs. Each pair shows a token currently up for auction next to the
 * artist who consigned it, sharing one outer border so they read as a
 * single composite card.
 *
 * The grid is split after the second row by a horizontal-scroll
 * carousel (`ActiveAuctionsStrip`) that surfaces every other active
 * auction — auctions whose seller's "one card per artist" slot was
 * already taken by the grid above. Each token appears at most once on
 * the page.
 */
export async function HomeSquare() {
  // Per-request rendering — Math.random() below would otherwise be
  // baked into a cached output and the grid would stop varying.
  noStore()

  // Pull a wide pool from every platform that surfaces active auctions.
  // Each adapter's `getActiveAuctions` is internally cached + cooldown-
  // bounded so this is at most one Postgres lookup per platform.
  const perPlatform = await Promise.all(
    PLATFORMS.map((p) =>
      p.getActiveAuctions
        ? p.getActiveAuctions(60).catch(
            () => [] as ActiveAuctionSummary[],
          )
        : Promise.resolve([] as ActiveAuctionSummary[]),
    ),
  )
  const auctions: ActiveAuctionSummary[] = perPlatform
    .flat()
    .sort((a, b) => {
      // Pre-bid auctions (endTime = 0) sort to the tail; otherwise
      // soonest-ending first.
      if (a.endTime === 0 && b.endTime !== 0) return 1
      if (b.endTime === 0 && a.endTime !== 0) return -1
      return a.endTime - b.endTime
    })

  // Resolve every seller's identity in parallel. getArtistIdentity is
  // cached, so even at cold start this is one round-trip per unique
  // artist (no duplicate work for sellers with multiple active auctions).
  const uniqueSellers = Array.from(
    new Set(auctions.map((a) => a.seller.toLowerCase())),
  )
  const identities = new Map(
    await Promise.all(
      uniqueSellers.map(
        async (addr) =>
          [addr, await getArtistIdentity(addr).catch(() => null)] as const,
      ),
    ),
  )

  // Partition by avatar presence, shuffle each partition independently,
  // then concatenate. Avatar-having artists fill the top of the wall;
  // each load picks a fresh random subset within each group.
  const withAvatar: typeof auctions = []
  const withoutAvatar: typeof auctions = []
  for (const a of auctions) {
    if (identities.get(a.seller.toLowerCase())?.avatarUrl) {
      withAvatar.push(a)
    } else {
      withoutAvatar.push(a)
    }
  }
  // Dedupe by seller: at most one card per artist on the home grid, so
  // a single seller with several active auctions doesn't dominate.
  const seenSellers = new Set<string>()
  const sortedAuctions = [
    ...shuffle(withAvatar),
    ...shuffle(withoutAvatar),
  ]
    .filter((a) => {
      const key = a.seller.toLowerCase()
      if (seenSellers.has(key)) return false
      seenSellers.add(key)
      return true
    })
    .slice(0, HOME_GRID_SIZE)

  // Strip = active auctions whose (contract, tokenId) wasn't picked
  // into the grid above. We surface only:
  //   1. Has a bid AND a future endTime — soonest-ending first
  //      (the countdown is real and the auction is closing).
  //   2. Pre-bid auctions (endTime === 0) — randomized for variety.
  // Auctions with `currentBidWei > 0n && endTime <= nowSec` are
  // zombies: bids landed but the natural end time has passed without
  // anyone calling `settle()` on-chain, so they linger in the
  // platform's active list. Showing them as "live" is misleading
  // (no real countdown) and as "bid" is noise — we drop them.
  const nowSec = Math.floor(Date.now() / 1000)
  const gridKeys = new Set(
    sortedAuctions.map((a) => `${a.platform}:${a.contract}:${a.tokenId}`),
  )
  const stripPool = auctions.filter(
    (a) => !gridKeys.has(`${a.platform}:${a.contract}:${a.tokenId}`),
  )
  const stripLiveCounting = stripPool
    .filter((a) => a.currentBidWei > 0n && a.endTime > nowSec)
    .sort((a, b) => a.endTime - b.endTime)
  const stripPreBid = shuffle(
    stripPool.filter((a) => a.currentBidWei === 0n),
  )
  const stripAuctions = [...stripLiveCounting, ...stripPreBid]

  const topHalf = sortedAuctions.slice(0, TOP_HALF_WORK_CARDS)
  const bottomHalf = sortedAuctions.slice(TOP_HALF_WORK_CARDS)

  const renderWorkCard = (w: ActiveAuctionSummary) => {
    const id = identities.get(w.seller.toLowerCase())
    return (
      <li
        key={`${w.platform}:${w.contract}:${w.tokenId}`}
        className="col-span-2"
      >
        <WorkArtistCard
          contract={w.contract}
          tokenId={w.tokenId}
          amount={w.currentBidWei === 0n ? w.reserveWei : w.currentBidWei}
          reservePrice={w.reserveWei}
          endTime={w.endTime}
          firstBidTime={0}
          artistAddress={w.seller}
          artistDisplayName={
            id?.displayName ??
            `${w.seller.slice(0, 6)}…${w.seller.slice(-4)}`
          }
          artistAvatarUrl={id?.avatarUrl ?? null}
          platform={w.platform}
        />
      </li>
    )
  }

  return (
    <div className="space-y-12">
      <ul className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:auto-rows-fr">
        <li className="col-span-2 row-span-1">
          <HomeHeroTile />
        </li>
        {topHalf.map(renderWorkCard)}
      </ul>

      <ActiveAuctionsStrip auctions={stripAuctions} />

      {bottomHalf.length > 0 ? (
        <ul className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:auto-rows-fr">
          {bottomHalf.map(renderWorkCard)}
        </ul>
      ) : null}
    </div>
  )
}
