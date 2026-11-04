import type { Metadata } from "next"
import { Suspense } from "react"
import { redirect } from "next/navigation"
import type { Address } from "viem"
import {
  getArtistGalleryPage,
  getArtistIdentity,
  resolveEnsAddress,
  type ArtistIdentity,
} from "@/lib/artist-queries"
import { getActiveAuctionCount } from "@/lib/auctions"
import { getSovereignHouseOf } from "@/lib/sovereign-house"
import { getCachedTokenRefs } from "@/lib/artist-cache"
import { getCachedCatalog } from "@/lib/catalog-cache"
import { isCrawler } from "@/lib/crawler"
import { withSingleFlight } from "@/lib/single-flight"
import { PLATFORMS } from "@/lib/platforms"
import { getCollectorTokens } from "@/lib/reads"
import { getSellerOpenAuctions } from "@/lib/profile-reads"
import { COLLECTED_PAGE_SIZE } from "@/lib/profile-collected"
import {
  PROFILE_TAB_LABELS,
  catalogEntryCount,
  parseProfileTab,
  selectProfileTabs,
  type ProfileTab,
  type ProfileTabCounts,
} from "@/lib/profile-tabs"
import { ArtistHeader } from "@/components/artist/ArtistHeader"
import { ArtistGallery } from "@/components/artist/ArtistGallery"
import { StudioBar } from "@/components/artist/StudioBar"
import { ProfileTabs } from "@/components/artist/ProfileTabs"
import {
  PanelErrorBoundary,
  PanelUnavailable,
} from "@/components/artist/PanelErrorBoundary"
import {
  AvailablePanel,
  CatalogPanel,
  CollectedPanel,
} from "@/components/artist/ProfilePanels"

const INITIAL_PAGE_SIZE = 24

type Params = Promise<{ address: string }>
type SearchParams = Promise<{ tab?: string | string[] }>

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

  try {
    const [identity, refs] = await Promise.all([
      getArtistIdentity(address),
      getCachedTokenRefs(address),
    ])
    const totalWorks = refs.length

    // A collector-only address (#299) gets a description that says so
    // instead of "0 works by …". Guarded: the holdings count is optional.
    const collected =
      totalWorks === 0
        ? await getCollectorTokens(address, { limit: 1, excludeOwnWorks: true })
            .then((p) => p.total)
            .catch(() => 0)
        : 0
    const description =
      collected > 0
        ? `${identity.displayName} holds ${collected} ${collected === 1 ? "work" : "works"} among those PND indexes`
        : `${totalWorks} ${totalWorks === 1 ? "work" : "works"} by ${identity.displayName}`
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
      ...(totalWorks === 0 && {
        robots: { index: false, follow: false },
      }),
    }
  } catch {
    return { title: `${address.slice(0, 6)}…${address.slice(-4)}` }
  }
}

export default async function ArtistPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { address: raw } = await params
  const { tab: rawTab } = await searchParams
  const requestedTab = parseProfileTab(rawTab)
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
    redirect(`/artist/${address}${requestedTab ? `?tab=${requestedTab}` : ""}`)
  }

  return (
    <Suspense fallback={<ArtistFetchFallback />}>
      <ArtistPageBody address={address} requestedTab={requestedTab} />
    </Suspense>
  )
}

/**
 * The unified person profile (#299). One address can have created works,
 * holdings, open auctions and Catalog declarations at once; each is a tab
 * (`?tab=`, lib/profile-tabs.ts), listed only when it has something to
 * show. Created stays the default for anyone with created works, so
 * existing artist links are unchanged; a collector-only address opens on
 * Collected instead of an empty gallery. `/profile/[address]` redirects
 * here (next.config.ts).
 */
async function ArtistPageBody({
  address,
  requestedTab,
}: {
  address: string
  requestedTab: ProfileTab | null
}) {
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

  // One count per tab, all Postgres (or an already-cached read), in
  // parallel: created refs (the gallery's own cached ref list), the first
  // holdings page (its `total` is the count, and the page is reused when
  // Collected is the tab shown), the Catalog record (the same cache the
  // old bottom-of-page CatalogSection read) and this address's open PND
  // auctions (a filter over the cached site-wide list). Every one degrades
  // to null instead of throwing, so a cold DB never 500s the profile; null
  // keeps the tab listed with a "could not load" panel.
  //
  // Expensive calls are wrapped in `withSingleFlight` so that a burst of
  // concurrent same-artist renders (e.g., a Discord/Twitter share that
  // funnels 50 visitors at the same artist within seconds) collapses to
  // one cold-cache fetch followed by N-1 cache hits, instead of N
  // parallel fan-outs racing each other to populate the same caches.
  const lower = address.toLowerCase()
  const [identity, refs, holdings, catalog, available, activeAuctionCount, sovereignHouse] =
    await Promise.all([
      getArtistIdentity(address).catch(() => fallbackIdentity(address)),
      withSingleFlight(`artist-refs:${lower}`, () => getCachedTokenRefs(address)).catch(
        (err) => {
          console.error("[artist] token refs read failed:", err)
          return null
        },
      ),
      withSingleFlight(`profile-holdings:${lower}:${COLLECTED_PAGE_SIZE}`, () =>
        getCollectorTokens(address, { limit: COLLECTED_PAGE_SIZE, excludeOwnWorks: true }),
      ).catch((err) => {
        console.error("[artist] holdings read failed:", err)
        return null
      }),
      getCachedCatalog(lower).catch(() => null),
      getSellerOpenAuctions(address),
      withSingleFlight(`artist-auctions:${lower}`, () =>
        getActiveAuctionCount(address),
      ).catch(() => null),
      getSovereignHouseOf(address).catch(() => null),
      auctionDiscoveryGate,
    ])

  // Only surface the auction count when the artist has actually deployed a
  // sovereign auction house — otherwise the indexer's "0 active auctions" is
  // noise. null hides the element in ArtistHeader.
  const activeAuctions = sovereignHouse ? activeAuctionCount : null

  const counts: ProfileTabCounts = {
    available: available?.length ?? null,
    created: refs?.length ?? null,
    collected: holdings?.total ?? null,
    catalog: catalog ? catalogEntryCount(catalog) : null,
  }
  const { active, tabs, defaultTab } = selectProfileTabs(requestedTab, counts)

  // This page is the person's public face — their record first, no admin
  // chrome. Management lives in /studio/[address]; the only owner
  // affordance here is the slim StudioBar ribbon (which renders null
  // for everyone else).
  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12">
      <ArtistHeader
        identity={identity}
        totalWorks={refs?.length ?? 0}
        activeAuctions={activeAuctions}
        collected={holdings?.total ?? null}
      />

      <div className="mt-8">
        <StudioBar artistAddress={address} />
      </div>

      <div className="mt-10">
        <ProfileTabs
          address={address}
          tabs={tabs}
          active={active}
          defaultTab={defaultTab}
          counts={counts}
        />
      </div>

      <div className="mt-8">
        <PanelErrorBoundary key={active} label={PROFILE_TAB_LABELS[active].toLowerCase()}>
          <Suspense fallback={<PanelSkeleton />}>
            {active === "available" ? (
              <AvailablePanel auctions={available} />
            ) : active === "collected" ? (
              <CollectedPanel address={address} page={holdings} />
            ) : active === "catalog" ? (
              <CatalogPanel address={address} count={counts.catalog} />
            ) : (
              <CreatedPanel address={address} refsKnown={refs !== null} />
            )}
          </Suspense>
        </PanelErrorBoundary>
      </div>
    </div>
  )
}

/**
 * The Created tab: the existing gallery. SSR only the first page;
 * subsequent pages load client-side via /api/artist/[address]/tokens?page=N.
 */
async function CreatedPanel({
  address,
  refsKnown,
}: {
  address: string
  refsKnown: boolean
}) {
  if (!refsKnown) return <PanelUnavailable label="created works" />
  const firstPage = await withSingleFlight(
    `artist-gallery:${address.toLowerCase()}:0:${INITIAL_PAGE_SIZE}`,
    () => getArtistGalleryPage(address, 0, INITIAL_PAGE_SIZE),
  ).catch((err) => {
    console.error("[artist] gallery page read failed:", err)
    return null
  })
  if (!firstPage) return <PanelUnavailable label="created works" />
  return <ArtistGallery artistAddress={address} initialPage={firstPage} />
}

/** Identity when the ENS store and live resolution both fail: the bare address. */
function fallbackIdentity(address: string): ArtistIdentity {
  return {
    address: address as Address,
    ensName: null,
    displayName: `${address.slice(0, 6)}…${address.slice(-4)}`,
    avatarUrl: null,
  }
}

function PanelSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="space-y-3">
          <div className="aspect-square rounded skeleton" />
          <div className="h-3 w-2/3 rounded skeleton" />
        </div>
      ))}
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
 * structure of `loading.tsx` (the route-level fallback).
 */
function ArtistFetchFallback() {
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
          Loading artist.
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
