import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { HomageField } from "@/components/collections/homage/HomageField"
import { CollectionTokenGallery } from "@/components/collections/CollectionTokenGallery"
import { getHomageMintedIds } from "@/lib/homage/collection.server"
import { getCollection } from "@/lib/collection-onchain"
import { getCollectionTokensPage } from "@/lib/indexer-queries"
import { resolveEnsAddress } from "@/lib/artist-queries"
import { detectHomageMinter } from "@/lib/homage/detect.server"
import { PND_CHAIN_ID } from "@/lib/collection"
import "@/components/mint/homage-gallery/homage-gallery.css"
import "../homage-skin.css"

// The full token set for a Surface collection. The registered Homage
// collection keeps its bespoke field; every other collection gets the generic
// paginated grid (indexed SELECT, cover thumbnails, no per-cell chain reads).

const PAGE_SIZE = 24

type Params = Promise<{ address: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address } = await params
  if (!isAddress(address)) return { title: "Collection" }
  const c = await getCollection(address as Address)
  return { title: c ? `${c.name} tokens` : "Collection" }
}

export default async function CollectionGalleryPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: Promise<{ page?: string; owner?: string }>
}) {
  const { address } = await params
  if (!isAddress(address)) notFound()
  const addr = address as Address
  const c = await getCollection(addr)
  if (!c) notFound()
  const homageMinter = await detectHomageMinter(addr, PND_CHAIN_ID)

  // Everyone but the registered Homage collection gets the generic grid.
  if (!homageMinter) {
    const { page: pageParam, owner: ownerParam } = await searchParams
    const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1)
    // Accept an address or an ENS name; resolve ENS via the cached helper.
    let ownerLabel: Address | null = null
    if (ownerParam) {
      ownerLabel = isAddress(ownerParam)
        ? (ownerParam as Address)
        : await resolveEnsAddress(ownerParam)
    }
    const result = await getCollectionTokensPage(
      addr,
      PAGE_SIZE,
      (page - 1) * PAGE_SIZE,
      ownerLabel,
    )
    const tokens = result?.tokens ?? []
    const total = result?.total ?? 0
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    return (
      <CollectionTokenGallery
        collection={addr}
        name={c.name}
        tokens={tokens}
        coverImage={c.cover}
        total={total}
        page={Math.min(page, totalPages)}
        totalPages={totalPages}
        ownerLabel={ownerLabel}
      />
    )
  }

  const mintedIds = await getHomageMintedIds(addr, 10_000)

  return (
    <div className="dark homage-terminal collection-homage-skin">
      <header className="px-6 pb-6 pt-24 lg:px-12 lg:pb-8 lg:pt-32">
        <nav className="mb-6 text-[10px] font-mono uppercase tracking-wider text-gray-400 lg:mb-8">
          <Link href={`/collections/${addr}`} className="hover:text-fg">
            ← {c.name}
          </Link>
        </nav>
        <h1 className="text-2xl font-medium tracking-tight text-fg sm:text-3xl">
          The full collection
        </h1>
      </header>
      <HomageField
        collection={addr}
        renderer={c.renderer}
        mintedIds={mintedIds}
        supply={c.cfg.supplyCap > 0n ? Number(c.cfg.supplyCap) : 10_000}
        minted={Number(c.minted)}
        mintHref={`/collections/${addr}#mint-instrument`}
        capped={false}
      />
    </div>
  )
}
