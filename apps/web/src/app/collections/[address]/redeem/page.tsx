import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { getCollection } from "@/lib/collection-onchain"
import { detectHomageMinter } from "@/lib/homage/detect.server"
import { PND_CHAIN_ID, evmNowAddressUrl, shortAddress } from "@/lib/collection"
import { HomageRedeem } from "@/components/collections/homage/HomageRedeem"
// The redeem page wears the same terminal skin as the collection page.
import "@/components/mint/homage-gallery/homage-gallery.css"
import "../homage-skin.css"

type Params = Promise<{ address: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address } = await params
  return { title: "Redeem" + (isAddress(address) ? "" : "") }
}

// A quiet, standalone page (linked from the collection record, not the mint flow): burn a
// homage you hold to reclaim the escrowed $111. Homage-only — 404s otherwise so it never
// shadows the /collections/<addr>/<tokenId> detail route for non-homage collections.
export default async function RedeemPage({ params }: { params: Params }) {
  const { address } = await params
  if (!isAddress(address)) notFound()
  const addr = address as Address
  const minter = await detectHomageMinter(addr, PND_CHAIN_ID)
  if (!minter) notFound()
  const c = await getCollection(addr)
  if (!c) notFound()

  return (
    <div className="dark homage-terminal collection-homage-skin min-h-screen">
      <header className="px-6 pb-8 pt-24 lg:px-12 lg:pt-32">
        <nav className="mb-8 text-[10px] font-mono uppercase tracking-wider text-gray-400 lg:mb-12">
          <Link href={`/collections/${addr}`} className="hover:text-fg">
            ← {c.name}
          </Link>
        </nav>
        <h1 className="text-4xl font-medium uppercase leading-none tracking-tight sm:text-5xl display">Redeem</h1>
      </header>

      <div className="border-y border-gray-200">
        <div className="mx-auto max-w-[640px] px-6 py-10 lg:px-12 lg:py-14">
          <HomageRedeem minter={minter} collection={addr} />
          <p className="mt-8 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <a
              href={evmNowAddressUrl(addr, PND_CHAIN_ID)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-fg"
            >
              {shortAddress(addr)} ↗
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
