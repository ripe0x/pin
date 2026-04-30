import { unstable_noStore as noStore } from "next/cache"
import { getActivePndAuctions } from "@/lib/indexer-queries"
import { getArtistIdentity } from "@/lib/artist-queries"
import { WorkArtistCard } from "./WorkArtistCard"
import { HomeHeroTile } from "./HomeHeroTile"

const HOME_GRID_SIZE = 11

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
 */
export async function HomeSquare() {
  // Per-request rendering — Math.random() below would otherwise be
  // baked into a cached output and the grid would stop varying.
  noStore()

  // Pull a wide pool so the random sample has variety. The query is a
  // single indexed read; cost is bounded by the wide pool size, not the
  // total active count.
  const auctions = (await getActivePndAuctions(60)) ?? []

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

  return (
    <ul className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:auto-rows-fr">
      <li className="col-span-2 row-span-1">
        <HomeHeroTile />
      </li>
      {sortedAuctions.map((w) => {
        const id = identities.get(w.seller.toLowerCase())
        return (
          <li
            key={`${w.house}:${w.tokenContract}:${w.tokenId}`}
            className="col-span-2"
          >
            <WorkArtistCard
              contract={w.tokenContract}
              tokenId={w.tokenId}
              amount={w.amount}
              reservePrice={w.reservePrice}
              endTime={w.endTime}
              firstBidTime={w.firstBidTime}
              artistAddress={w.seller}
              artistDisplayName={
                id?.displayName ??
                `${w.seller.slice(0, 6)}…${w.seller.slice(-4)}`
              }
              artistAvatarUrl={id?.avatarUrl ?? null}
            />
          </li>
        )
      })}
    </ul>
  )
}
