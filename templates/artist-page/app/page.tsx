import { ArtistHero } from "@/components/ArtistHero"
import { AuctionCard, bucketFor } from "@/components/AuctionCard"
import { Footer } from "@/components/Footer"
import {
  getAllAuctions,
  getArtistHouse,
  type AuctionSummary,
} from "@/lib/auctions"

export const revalidate = 60

const BUCKET_RANK: Record<ReturnType<typeof bucketFor>, number> = {
  active: 0,
  ending: 1,
  listed: 2,
  settled: 3,
  cancelled: 4,
}

function compareAuctions(a: AuctionSummary, b: AuctionSummary): number {
  const ra = BUCKET_RANK[bucketFor(a)]
  const rb = BUCKET_RANK[bucketFor(b)]
  if (ra !== rb) return ra - rb
  // Within active/ending: ending soonest first.
  // Within listed/past: newest auctionId first.
  const ba = bucketFor(a)
  if (ba === "active" || ba === "ending") {
    return Number(a.endTime) - Number(b.endTime)
  }
  return Number(b.auctionId) - Number(a.auctionId)
}

export default async function HomePage() {
  const [auctions, house] = await Promise.all([
    getAllAuctions(),
    getArtistHouse(),
  ])

  const sorted = [...auctions].sort(compareAuctions)
  const activeCount = auctions.filter((a) => {
    const b = bucketFor(a)
    return b === "active" || b === "ending"
  }).length

  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12 space-y-12">
      <ArtistHero
        totalAuctions={auctions.length}
        activeAuctions={activeCount}
      />

      {!house ? (
        <NoHouseState />
      ) : sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="columns-1 sm:columns-2 lg:columns-4 gap-6 [&>*]:mb-6 [&>*]:break-inside-avoid">
          {sorted.map((a) => (
            <AuctionCard key={a.auctionId} auction={a} />
          ))}
        </div>
      )}

      <Footer />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="border border-dashed border-gray-200 p-12 text-center">
      <p className="text-sm text-fg-muted">
        No auctions yet — they&rsquo;ll appear here once they&rsquo;re created on-chain.
      </p>
    </div>
  )
}

function NoHouseState() {
  return (
    <div className="border border-dashed border-gray-200 p-12 text-center space-y-2">
      <p className="text-sm font-medium">Auction house not deployed</p>
      <p className="text-sm text-fg-muted max-w-md mx-auto">
        This wallet hasn&rsquo;t deployed a Sovereign auction house yet. Deploy
        one in the main app, then auctions you create will show up here.
      </p>
    </div>
  )
}
