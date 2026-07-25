import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import {
  getCollection,
  getCollectionToken,
  getRouterBatches,
  isBatchRenderRouter,
} from "@/lib/collection-onchain"
import { PND_CHAIN_ID, evmNowAddressUrl } from "@/lib/collection"

/**
 * A batch's filtered token list: every minted token in [startId, endId],
 * reached from a BatchGrid card. Every token in a batch shares the same
 * artwork (docs/pnd-surface-second-launch.md), so this fetches the
 * artwork ONCE (getCollectionToken(startId), already cached) and reuses
 * it as the thumbnail for every id in the range — no per-token tokenURI
 * read, matching the repo's RPC discipline for a page that can list up
 * to a batch's full size.
 */

type Params = Promise<{ address: string; index: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address } = await params
  if (!isAddress(address)) return { title: "Batch" }
  const c = await getCollection(address as Address)
  return { title: c ? `${c.name} — batch` : "Batch" }
}

export default async function BatchPage({ params }: { params: Params }) {
  const { address, index: indexRaw } = await params
  if (!isAddress(address)) notFound()
  const addr = address as Address
  const index = Number(indexRaw)
  if (!Number.isInteger(index) || index < 0) notFound()

  const c = await getCollection(addr)
  if (!c) notFound()
  const isRouter = await isBatchRenderRouter(c.renderer)
  if (!isRouter) notFound()

  const batches = await getRouterBatches(c.renderer)
  const batch = batches[index]
  if (!batch) notFound()

  const startToken = await getCollectionToken(addr, batch.startId)
  const image = startToken?.image ?? ""

  const lastMinted = batch.endId < c.minted ? batch.endId : c.minted
  const ids: bigint[] = []
  if (lastMinted >= batch.startId) {
    for (let id = batch.startId; id <= lastMinted; id++) ids.push(id)
  }

  return (
    <div className="px-6 py-10 lg:px-12 lg:py-14">
      <nav className="mb-6 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        <Link href={`/collections/${addr}`} className="hover:text-fg">
          ← {c.name}
        </Link>
      </nav>
      <header className="mb-8 space-y-1">
        <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
          {batch.label || `Batch ${index + 1}`}
        </h1>
        <p className="text-[11px] font-mono uppercase tracking-wider text-gray-400">
          #{batch.startId.toString()}–{batch.endId.toString()} ·{" "}
          <a
            href={evmNowAddressUrl(batch.vendor, PND_CHAIN_ID)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-fg"
          >
            renderer {batch.vendor.slice(0, 6)}…{batch.vendor.slice(-4)}
          </a>
        </p>
      </header>

      {ids.length === 0 ? (
        <p className="text-[11px] font-mono uppercase tracking-wider text-gray-400">
          Nothing minted in this batch yet.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-px bg-gray-200 sm:grid-cols-4 lg:grid-cols-6 dark:bg-gray-800">
          {ids.map((id) => (
            <Link
              key={id.toString()}
              href={`/collections/${addr}/${id.toString()}`}
              className="group relative flex aspect-square flex-col justify-end overflow-hidden bg-surface"
            >
              {image ? (
                <OptimizedImage
                  src={image}
                  alt={`Token #${id.toString()}`}
                  width={400}
                  className="absolute inset-0 h-full w-full object-cover transition-opacity group-hover:opacity-80"
                />
              ) : null}
              <p className="relative z-10 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5 text-[10px] font-mono text-white">
                #{id.toString()}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
