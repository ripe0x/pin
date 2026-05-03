import type { Metadata } from "next"
import { Suspense } from "react"
import { redirect } from "next/navigation"
import type { Address } from "viem"
import {
  getArtistGalleryPage,
  getArtistIdentity,
  resolveEnsAddress,
} from "@/lib/artist-queries"
import { getActiveAuctionCount } from "@/lib/auctions"
import { getCachedTokenRefs } from "@/lib/artist-cache"
import { pgCacheHas } from "@/lib/pg-cache"
import { isCrawler } from "@/lib/crawler"
import { PLATFORMS } from "@/lib/platforms"
import { ArtistHeader } from "@/components/artist/ArtistHeader"
import { ArtistGallery } from "@/components/artist/ArtistGallery"
import { BulkDelistPanel } from "@/components/listings/BulkDelistPanel"
import { SovereignBulkPanel } from "@/components/listings/SovereignBulkPanel"
import { MigrationBanner } from "@/components/migrate/MigrationBanner"

const INITIAL_PAGE_SIZE = 24

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

async function resolveParam(raw: string): Promise<string | null> {
  const decoded = decodeURIComponent(raw)
  if (ADDRESS_RE.test(decoded)) return decoded

  // Try ENS resolution
  const resolved = await resolveEnsAddress(decoded)
  return resolved ?? null
}

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { address: raw } = await params
  const address = await resolveParam(raw)

  if (!address) {
    return { title: `Could not resolve "${decodeURIComponent(raw)}"` }
  }

  // Cheap path: refs only (no enrichment) — gives us the work count without
  // paying for thousands of IPFS fetches in the metadata route.
  const [identity, refs] = await Promise.all([
    getArtistIdentity(address),
    getCachedTokenRefs(address),
  ])
  const totalWorks = refs.length

  const description = `${totalWorks} ${totalWorks === 1 ? "work" : "works"} by ${identity.displayName}`
  return {
    title: identity.displayName,
    description,
    openGraph: {
      title: identity.displayName,
      description,
      type: "profile",
    },
    twitter: {
      card: "summary_large_image",
      title: identity.displayName,
      description,
    },
  }
}

export default async function ArtistPage({
  params,
}: {
  params: Params
}) {
  const { address: raw } = await params
  const decoded = decodeURIComponent(raw)
  const address = await resolveParam(raw)

  if (!address) {
    return (
      <div className="mx-auto max-w-[2000px] px-6 py-12 text-center">
        <h1 className="text-2xl font-semibold">Not Found</h1>
        <p className="text-gray-500 mt-2">
          Could not resolve &ldquo;{decoded}&rdquo; to an Ethereum address.
        </p>
      </div>
    )
  }

  // If user navigated via ENS name, redirect to the canonical address URL
  if (!ADDRESS_RE.test(decoded)) {
    redirect(`/artist/${address}`)
  }

  // Fast pre-check (~10ms SQL point lookup). Used purely to choose the
  // loading copy: cold cache → "Indexing this artist for the first time."
  // already warm → "Loading artist." Doesn't gate the actual fetch.
  const isWarm = await pgCacheHas(`ens:${address.toLowerCase()}`)

  return (
    <Suspense fallback={<ArtistFetchFallback isWarm={isWarm} />}>
      <ArtistPageBody address={address} />
    </Suspense>
  )
}

async function ArtistPageBody({ address }: { address: string }) {
  // Crawlers (Twitterbot, Discord, Slack, etc.) only need the OG metadata
  // produced by `generateMetadata` — they don't render the gallery,
  // can't bid, and don't care about live state. Skipping the body
  // entirely keeps a burst of link-unfurl requests from cold-firing
  // `getArtistGalleryPage` (token discovery + multicall enrichment) and
  // `getActiveAuctionCount` (sovereign house log scan) per crawler hit.
  // Real users land on the full path below.
  if (await isCrawler()) {
    return <ArtistCrawlerShell />
  }

  // Per-artist auction discovery — fire each adapter's
  // `discoverArtistAuctions` so this artist's `lazy_*_active_auctions`
  // rows are populated/refreshed for the home grid. Self-cooled to
  // 2 min per (artist, platform) so repeated artist-page hits no-op.
  // Awaited up to 3s so first-time visits commonly resolve before
  // SSR returns; longer-running scans keep running and finalize on a
  // subsequent visit (the next render reads whatever's in the table).
  const auctionDiscovery = Promise.allSettled(
    PLATFORMS.map(() =>
      // TODO(rpc-rollback): re-enable once the per-artist scanner is
      // cursor-bounded — `discoverArtistAuctions` currently fires
      // wide `getLogs` from each marketplace's deploy block, which
      // slams Alchemy on every cold artist-page visit.
      Promise.resolve(),
    ),
  )
  const auctionDiscoveryDeadline = new Promise<void>((resolve) =>
    setTimeout(resolve, 3000),
  )
  const auctionDiscoveryGate = Promise.race([
    auctionDiscovery.then(() => undefined),
    auctionDiscoveryDeadline,
  ])

  // SSR only the first page: identity + first 24 tokens + active-auction
  // count (null when the artist has no sovereign house). Subsequent gallery
  // pages load client-side via /api/artist/[address]/tokens?page=N.
  const [identity, firstPage, activeAuctions] = await Promise.all([
    getArtistIdentity(address),
    getArtistGalleryPage(address, 0, INITIAL_PAGE_SIZE),
    getActiveAuctionCount(address).catch(() => null),
    auctionDiscoveryGate,
  ])

  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12">
      <ArtistHeader
        identity={identity}
        totalWorks={firstPage.total}
        activeAuctions={activeAuctions}
      />

      <div className="mt-8">
        <MigrationBanner artistAddress={address} />
      </div>

      <div className="mt-4">
        <BulkDelistPanel artistAddress={address} />
      </div>

      <div className="mt-4">
        <SovereignBulkPanel artistAddress={address} />
      </div>

      <div className="mt-12">
        <ArtistGallery
          artistAddress={address}
          initialPage={firstPage}
        />
      </div>
    </div>
  )
}

/**
 * Minimal HTML shell served to crawlers. The OG metadata in the head
 * (from `generateMetadata`) is what they actually consume; the body
 * just needs to be valid HTML with the artist's name surfaced as plain
 * text so the page reads sensibly if someone scrapes it for indexing.
 */
function ArtistCrawlerShell() {
  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12">
      <p className="text-sm text-gray-500">Loading artist page…</p>
    </div>
  )
}

/**
 * Loading state shown while `ArtistPageBody` is fetching. Mirrors the
 * structure of `loading.tsx` (the route-level fallback) but is parameterized
 * on whether the artist is already in the shared cache, so we can show
 * different copy for first-visit vs. subsequent visits.
 */
function ArtistFetchFallback({ isWarm }: { isWarm: boolean }) {
  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12">
      <div className="flex items-center gap-6">
        <div className="h-20 w-20 rounded-full skeleton" />
        <div className="space-y-3">
          <div className="h-7 w-48 rounded skeleton" />
          <div className="h-4 w-32 rounded skeleton" />
        </div>
      </div>

      <div className="mt-12 text-center">
        <p className="text-sm text-gray-600 animate-pulse">
          {isWarm
            ? "Loading artist."
            : "Indexing this artist for the first time."}
        </p>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <div className="aspect-[4/5] rounded-lg skeleton" />
            <div className="h-4 w-3/4 rounded skeleton" />
            <div className="h-3 w-1/2 rounded skeleton" />
          </div>
        ))}
      </div>
    </div>
  )
}
