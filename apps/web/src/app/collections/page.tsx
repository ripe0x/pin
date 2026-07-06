import type { Metadata } from "next"
import Link from "next/link"
import { getRecentCollections } from "@/lib/collection-onchain"
import { formatPriceLabel, shortAddress, sovereignCollectionFactory } from "@/lib/sovereign-collection"

export const metadata: Metadata = {
  title: "Collections",
  description:
    "Release onchain art as sovereign collections you own. Every token keeps its own identity and onchain Mint Mark. Mainnet only. Honest pricing.",
}

export const revalidate = 3600

export default async function CollectionsHome() {
  const factory = sovereignCollectionFactory()
  const recent = factory ? await getRecentCollections(factory, 8) : []

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 md:py-16 space-y-12">
      <header className="space-y-5">
        <h1 className="text-2xl md:text-3xl font-medium tracking-tight">PND Collections</h1>
        <p className="text-sm text-fg-muted leading-relaxed max-w-xl">
          Release onchain art as sovereign collections you own outright. Shared
          artwork and shared mint conditions, but every token keeps its own
          identity, so it can carry provenance now and point somewhere later.
          Mainnet only. The price you set is the price collectors pay.
        </p>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 pt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
          <li>Artist owned contracts</li>
          <li>Mint Marks, not rarity</li>
          <li>Attribution roster</li>
          <li>Self hostable</li>
        </ul>
      </header>

      {factory === null ? (
        <section className="rounded-lg border border-gray-200 bg-surface p-6">
          <p className="text-sm text-fg-muted leading-relaxed">
            Collections are not yet live on this network. Check back soon.
          </p>
        </section>
      ) : recent.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Recent collections
          </h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {recent.map((c) => (
              <li key={c.address}>
                <Link
                  href={`/collections/${c.address}`}
                  className="block rounded-lg border border-gray-200 bg-surface p-4 hover:border-gray-300 transition-colors"
                >
                  <p className="text-sm font-medium tracking-tight truncate">{c.name}</p>
                  <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    {c.symbol} · {shortAddress(c.address)}
                  </p>
                  <p className="mt-2 text-[10px] font-mono text-gray-500 tabular-nums">
                    {formatPriceLabel(c.cfg.price)} · {Number(c.minted)} minted
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
