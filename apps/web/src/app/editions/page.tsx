import type { Metadata } from "next"
import Link from "next/link"
import { getRecentEditions } from "@/lib/editions-onchain"
import { EDITION_STATUS_LABEL, formatPriceLabel, pndEditionsFactory, shortAddress } from "@/lib/pnd-editions"

export const metadata: Metadata = {
  title: "Editions",
  description:
    "Release onchain art as ERC721 editions you own. Every token keeps its own identity and onchain Mint Mark. Mainnet only. Honest pricing.",
}

export const revalidate = 3600

export default async function EditionsHome() {
  const factory = pndEditionsFactory()
  const recent = factory ? await getRecentEditions(factory, 8) : []

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 md:py-16 space-y-12">
      <header className="space-y-5">
        <h1 className="text-2xl md:text-3xl font-medium tracking-tight">PND Editions</h1>
        <p className="text-sm text-fg-muted leading-relaxed max-w-xl">
          Release onchain art as ERC721 editions you own outright. Shared
          artwork and shared mint conditions, but every token keeps its own
          identity, so it can carry provenance now and point somewhere later.
          Mainnet only. The price you set is the price collectors pay.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link
            href="/editions/new"
            className="text-[11px] font-mono font-medium uppercase tracking-wider px-5 py-3 bg-fg text-bg hover:opacity-80 transition-colors"
          >
            Create an edition
          </Link>
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 pt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
          <li>Artist owned contracts</li>
          <li>Mint Marks, not rarity</li>
          <li>Edition graph + token path</li>
          <li>Self hostable</li>
        </ul>
      </header>

      {recent.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Recent editions
          </h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {recent.map((e) => (
              <li key={e.address}>
                <Link
                  href={`/editions/${e.address}`}
                  className="block rounded-lg border border-gray-200 bg-surface p-4 hover:border-gray-300 transition-colors"
                >
                  <p className="text-sm font-medium tracking-tight truncate">{e.name}</p>
                  <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    {e.symbol} · {shortAddress(e.address)}
                  </p>
                  <p className="mt-2 text-[10px] font-mono text-gray-500 tabular-nums">
                    {formatPriceLabel(e.cfg.price)} · {Number(e.minted)} minted ·{" "}
                    {EDITION_STATUS_LABEL[e.status]}
                    {e.isSealed ? " · sealed" : ""}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
