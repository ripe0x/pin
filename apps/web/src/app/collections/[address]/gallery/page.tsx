import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { HomageField } from "@/components/collections/homage/HomageField"
import { getHomageMintedIds } from "@/lib/homage/collection.server"
import { getCollection } from "@/lib/collection-onchain"
import { detectHomageMinter } from "@/lib/homage/detect.server"
import { PND_CHAIN_ID } from "@/lib/collection"
import "@/components/mint/homage-gallery/homage-gallery.css"
import "../homage-skin.css"

// The full Homage set, uncapped, for people who scroll past the homepage's
// short preview. Only reachable for the homage collection — every other
// collection's grid renders inline via ParityMosaic/OnchainMosaic.

type Params = Promise<{ address: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address } = await params
  if (!isAddress(address)) return { title: "Collection" }
  const c = await getCollection(address as Address)
  return { title: c ? `${c.name} — full collection` : "Collection" }
}

export default async function HomageGalleryPage({ params }: { params: Params }) {
  const { address } = await params
  if (!isAddress(address)) notFound()
  const addr = address as Address
  const c = await getCollection(addr)
  if (!c) notFound()
  const homageMinter = await detectHomageMinter(addr, PND_CHAIN_ID)
  if (!homageMinter) notFound()

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
