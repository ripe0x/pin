import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { SITE_TITLE } from "@pin/shared"
import {
  getArtistPortfolio,
  resolveEnsAddress,
  tokenToDisplayData,
} from "@/lib/artist-queries"
import { ArtistHeader } from "@/components/artist/ArtistHeader"
import { ArtistGallery } from "@/components/artist/ArtistGallery"

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

  const portfolio = await getArtistPortfolio(address)
  const { identity } = portfolio

  return {
    title: `${identity.displayName} | ${SITE_TITLE}`,
    description: `${portfolio.totalWorks} works on Foundation by ${identity.displayName}`,
    openGraph: {
      title: `${identity.displayName} — Foundation Artist`,
      description: `${portfolio.totalWorks} works on Foundation`,
      type: "profile",
    },
    twitter: {
      card: "summary_large_image",
      title: `${identity.displayName} — Foundation Artist`,
      description: `${portfolio.totalWorks} works on Foundation`,
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

  const portfolio = await getArtistPortfolio(address)
  const displayItems = portfolio.tokens.map(tokenToDisplayData)

  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12">
      <ArtistHeader
        identity={portfolio.identity}
        totalWorks={portfolio.totalWorks}
      />

      <div className="mt-12">
        <ArtistGallery items={displayItems} artistAddress={address} />
      </div>
    </div>
  )
}
