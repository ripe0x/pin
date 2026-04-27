import type { Metadata } from "next"
import { redirect } from "next/navigation"
import {
  getArtistGalleryPage,
  getArtistIdentity,
  resolveEnsAddress,
} from "@/lib/artist-queries"
import { getCachedTokenRefs } from "@/lib/artist-cache"
import { ArtistHeader } from "@/components/artist/ArtistHeader"
import { ArtistGallery } from "@/components/artist/ArtistGallery"
import { BulkDelistPanel } from "@/components/listings/BulkDelistPanel"

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

  // SSR only the first page: identity + first 24 tokens. Subsequent pages
  // load client-side via /api/artist/[address]/tokens?page=N.
  const [identity, firstPage] = await Promise.all([
    getArtistIdentity(address),
    getArtistGalleryPage(address, 0, INITIAL_PAGE_SIZE),
  ])

  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12">
      <ArtistHeader identity={identity} totalWorks={firstPage.total} />

      <div className="mt-8">
        <BulkDelistPanel artistAddress={address} />
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
