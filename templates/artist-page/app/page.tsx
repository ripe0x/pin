import { ArtistHero } from "@/components/ArtistHero"
import { AuctionCard, bucketFor } from "@/components/AuctionCard"
import { CollectionMintCard } from "@/components/CollectionMintCard"
import { CollectionTokenGrid } from "@/components/CollectionTokenGrid"
import { Footer } from "@/components/Footer"
import {
  getAllAuctions,
  getArtistHouse,
  type AuctionSummary,
} from "@/lib/auctions"
import { getConfig } from "@/lib/config"
import { getCollection, getCurrentPrice } from "@/lib/collection"
import { IdMode } from "@/lib/sovereign-collection"

// Rendered on demand, not prerendered at build, so a deploy never crawls the
// chain (archive eth_getLogs at build time is exactly what used to fail the
// build). The expensive reads live behind `unstable_cache` (see
// lib/auctions.ts): live auctions refresh ~60s via stale-while-revalidate and
// immutable past auctions are cached until a new one settles, so request-time
// rendering is cheap and the build ships zero RPC.
export const dynamic = "force-dynamic"

const BUCKET_RANK: Record<ReturnType<typeof bucketFor>, number> = {
  active: 0,
  ending: 1,
  listed: 2,
  settled: 3,
  cancelled: 4,
}

/**
 * Collapse the grid to one card per token. A token can have many auctions
 * over its life (listed, cancelled, relisted, sold), but the gallery should
 * show each work once. Among a token's auctions we keep the most relevant by
 * bucket rank (active → ending → listed → settled → cancelled), breaking ties
 * with the newest auctionId. Tokens whose only auctions were cancelled are
 * dropped entirely — a listing that was created and cancelled isn't a work to
 * showcase. The full auction list is preserved elsewhere (getAuctionById), so
 * direct links to any auction, including cancelled ones, still resolve.
 */
function dedupeByToken(auctions: AuctionSummary[]): AuctionSummary[] {
  const best = new Map<string, AuctionSummary>()
  for (const a of auctions) {
    const key = `${a.tokenContract.toLowerCase()}:${a.tokenId}`
    const cur = best.get(key)
    if (!cur) {
      best.set(key, a)
      continue
    }
    const ra = BUCKET_RANK[bucketFor(a)]
    const rc = BUCKET_RANK[bucketFor(cur)]
    if (ra < rc || (ra === rc && Number(a.auctionId) > Number(cur.auctionId))) {
      best.set(key, a)
    }
  }
  return [...best.values()].filter((a) => bucketFor(a) !== "cancelled")
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
  const { collectionAddress, artistAddress } = getConfig()
  const [auctions, house] = await Promise.all([
    getAllAuctions(),
    getArtistHouse(),
  ])

  const unique = dedupeByToken(auctions)
  const sorted = [...unique].sort(compareAuctions)
  const activeCount = unique.filter((a) => {
    const b = bucketFor(a)
    return b === "active" || b === "ending"
  }).length

  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12 space-y-12">
      <ArtistHero
        totalAuctions={unique.length}
        activeAuctions={activeCount}
      />

      {collectionAddress ? (
        <CollectionSection
          collectionAddress={collectionAddress}
          artistAddress={artistAddress}
        />
      ) : null}

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

/**
 * Mint card + recent-mints grid for the artist's optional SovereignCollection.
 * Entirely absent from the page unless `NEXT_PUBLIC_COLLECTION_ADDRESS` is
 * configured (see lib/config.ts) — the section itself, and every read behind
 * it, only runs when an artist has opted in.
 */
async function CollectionSection({
  collectionAddress,
  artistAddress,
}: {
  collectionAddress: NonNullable<
    Awaited<ReturnType<typeof getConfig>>["collectionAddress"]
  >
  artistAddress: Awaited<ReturnType<typeof getConfig>>["artistAddress"]
}) {
  const [collection, price] = await Promise.all([
    getCollection(),
    getCurrentPrice(),
  ])
  if (!collection) return null

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-8 items-start">
        <div className="space-y-1">
          <h2 className="text-base font-mono font-medium tracking-tight truncate">
            {collection.name}
          </h2>
          <CollectionMintCard
            collectionAddress={collectionAddress}
            artistAddress={artistAddress}
            initial={{
              name: collection.name,
              // Bigint fields must cross the server/client boundary as
              // strings — Next.js can't serialize a raw bigint in the RSC
              // payload (see SerializedCollectionConfig's doc comment in
              // CollectionMintCard.tsx).
              cfg: {
                ...collection.cfg,
                price: collection.cfg.price.toString(),
                supplyCap: collection.cfg.supplyCap.toString(),
                mintStart: collection.cfg.mintStart.toString(),
                mintEnd: collection.cfg.mintEnd.toString(),
              },
              status: collection.status,
              minted: collection.minted.toString(),
              price: price !== null ? price.toString() : null,
            }}
          />
        </div>
        {collection.cfg.idMode === IdMode.Sequential ? (
          <CollectionTokenGrid
            collectionAddress={collectionAddress}
            minted={collection.minted}
          />
        ) : null}
      </div>
    </div>
  )
}
