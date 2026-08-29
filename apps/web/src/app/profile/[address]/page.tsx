import type { Metadata } from "next"
import { permanentRedirect } from "next/navigation"
import {
  getIndexedArtistIdentity,
  resolveEnsAddress,
} from "@/lib/artist-queries"
import {
  getProfileCatalogEvidence,
  getProfileGalleryPage,
  getProfileHoldingsPage,
  getProfileOpenReleases,
  getProfileSummary,
  getProfileTransferredPage,
  isProfileAddress,
} from "@/lib/profile-queries"
import { StudioBar } from "@/components/artist/StudioBar"
import { ProfileAvailable } from "@/components/profile/ProfileAvailable"
import { ProfileCatalog } from "@/components/profile/ProfileCatalog"
import { ProfileCoverage, ProfileCuration } from "@/components/profile/ProfileCoverage"
import { ProfileCreatedRecord } from "@/components/profile/ProfileCreatedRecord"
import { ProfileHeader } from "@/components/profile/ProfileHeader"
import {
  ProfileHoldings,
  ProfileTransferredArchive,
} from "@/components/profile/ProfileHoldings"
import { ProfileNav } from "@/components/profile/ProfileNav"

const PAGE_SIZE = 24

type Params = Promise<{ address: string }>
type SearchParams = Promise<{ createdPage?: string }>

async function resolveProfileAddress(raw: string): Promise<string | null> {
  const decoded = decodeURIComponent(raw)
  if (isProfileAddress(decoded)) return decoded.toLowerCase()
  return (await resolveEnsAddress(decoded))?.toLowerCase() ?? null
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address: raw } = await params
  const address = await resolveProfileAddress(raw)
  if (!address) return { title: "Profile not found", robots: { index: false, follow: false } }
  const identity = await getIndexedArtistIdentity(address)
  return {
    title: identity.displayName,
    description: `${identity.displayName}'s indexed created work, current holdings, Catalog declarations, and artist-owned infrastructure on PND.`,
    alternates: { canonical: `/profile/${address}` },
    openGraph: { title: identity.displayName, type: "profile" },
  }
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const [{ address: raw }, query] = await Promise.all([params, searchParams])
  const decoded = decodeURIComponent(raw)
  const address = await resolveProfileAddress(raw)
  if (!address) {
    return (
      <div className="mx-auto max-w-[1200px] px-6 py-12 text-center">
        <h1 className="text-2xl font-semibold">Profile not found</h1>
        <p className="mt-2 text-sm text-gray-500">
          Could not resolve &ldquo;{decoded}&rdquo; to an Ethereum address.
        </p>
      </div>
    )
  }
  if (!isProfileAddress(decoded) || decoded !== address) {
    permanentRedirect(`/profile/${address}`)
  }

  const requestedPage = Number.parseInt(query.createdPage ?? "1", 10)
  const createdPage = Number.isFinite(requestedPage) && requestedPage > 0
    ? requestedPage - 1
    : 0

  const [identity, gallery, catalog, holdings, transferred, openReleases] = await Promise.all([
    getIndexedArtistIdentity(address),
    getProfileGalleryPage(address, createdPage, PAGE_SIZE),
    getProfileCatalogEvidence(address),
    getProfileHoldingsPage(address, null, PAGE_SIZE),
    getProfileTransferredPage(address, null, PAGE_SIZE),
    getProfileOpenReleases(address),
  ])
  const declaredTotal = catalog.contracts.length + catalog.tokens.length + catalog.ranges.length
  const summary = await getProfileSummary({
    address,
    createdTotal: gallery.total,
    availableTotal: gallery.availableTotal + openReleases.length,
    openReleaseTotal: openReleases.length,
    declaredTotal,
  })
  const empty =
    summary.createdTotal === 0 && summary.heldTotal === 0 && summary.declaredTotal === 0 &&
    summary.surfaceCount === 0 && summary.auctionHouseCount === 0

  return (
    <main className="mx-auto max-w-[2000px] px-6 py-12">
      <ProfileHeader identity={identity} summary={summary} />
      <ProfileNav summary={summary} />
      <div className="mt-6"><StudioBar artistAddress={address} /></div>
      <div className="mt-6"><ProfileCoverage summary={summary} /></div>

      {empty ? (
        <div className="py-16 text-center text-gray-500">
          <p className="text-lg">No indexed profile evidence yet</p>
          <p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed">
            PND has not observed created work, current holdings, Catalog declarations, or PND-owned infrastructure for this address. This does not mean none exists elsewhere.
          </p>
        </div>
      ) : (
        <div className="mt-12 space-y-16">
          {createdPage === 0 && (
            <ProfileAvailable
              releases={openReleases}
              items={gallery.tokens}
              listingTotal={gallery.availableTotal}
            />
          )}
          <ProfileCreatedRecord address={address} page={gallery} />
          <ProfileTransferredArchive address={address} initialPage={transferred} />
          <ProfileHoldings address={address} initialPage={holdings} />
          <ProfileCatalog address={address} catalog={catalog} />
        </div>
      )}
      <div className="mt-16"><ProfileCuration /></div>
    </main>
  )
}
