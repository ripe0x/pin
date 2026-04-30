import { getActivePndAuctions } from "@/lib/indexer-queries"
import { getArtistIdentity } from "@/lib/artist-queries"
import { WorkArtistCard } from "./WorkArtistCard"
import { HomeHeroTile } from "./HomeHeroTile"

/**
 * The home page itself — a single composition: a wall of cards where the
 * top-left cell is editorial (the hero) and the rest are "work + artist"
 * pairs. Each pair shows a token currently up for auction next to the
 * artist who consigned it, sharing one outer border so they read as a
 * single composite card.
 */
export async function HomeSquare() {
  const auctions = (await getActivePndAuctions(11)) ?? []

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

  // Stable-sort: cards whose artist has an avatar render first. Empty-
  // avatar cards still appear, just lower in the grid — keeps the top
  // of the wall visually filled without removing anyone from the page.
  const sortedAuctions = [...auctions].sort((a, b) => {
    const aHas = !!identities.get(a.seller.toLowerCase())?.avatarUrl
    const bHas = !!identities.get(b.seller.toLowerCase())?.avatarUrl
    if (aHas === bHas) return 0
    return aHas ? -1 : 1
  })

  return (
    <ul className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-fr">
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
