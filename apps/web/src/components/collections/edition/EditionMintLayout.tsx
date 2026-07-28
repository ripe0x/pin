import type { ReactNode } from "react"
import Link from "next/link"

/**
 * Generic "edition mint" collection layout: one artwork (or a batch grid),
 * many mints — the auction page's sticky-artwork-left / scrolling-panel-right
 * structure (see app/auction/[house]/[auctionId]/page.tsx), adapted for a
 * direct-sale collection instead of a bid. Selected by
 * lib/launch-descriptors.ts' layoutKind lookup, not hardcoded per address;
 * any collection can use it by pointing its descriptor's layoutKind at
 * "edition". Purely presentational — hero, mint instrument, and facts are
 * all passed in by the collection page, which owns every onchain read.
 */
export function EditionMintLayout({
  name,
  subtitle,
  byline,
  hero,
  mintInstrument,
  description,
  history,
  about,
  facts,
}: {
  name: string
  /** The work's own title, shown under the collection name for a piece whose
   *  title differs from its collection (e.g. "Escape (blue)" in "abstracts").
   *  Omitted renders nothing. */
  subtitle?: ReactNode
  byline: ReactNode
  /** The artwork: a single image, or a BatchGrid for a batch-editions launch. */
  hero: ReactNode
  /** The mint CTA (MintCollectionCTA or equivalent). */
  mintInstrument: ReactNode
  /** The work's description, shown above the mint instrument (the auction
   *  page keeps its blurb high in the sidebar too). Omitted renders nothing. */
  description?: ReactNode
  /** Mint history (CollectionMintHistory or equivalent); renders its own
   *  section, or nothing when there are no mints yet. */
  history?: ReactNode
  about?: ReactNode
  facts: { label: string; value: ReactNode }[]
}) {
  return (
    <div className="grid min-h-[calc(100vh-64px)] grid-cols-1 lg:grid-cols-[2fr_1fr]">
      {/* Left: sticky artwork, same treatment as the auction page. */}
      <div className="flex items-center justify-center bg-gray-100 p-8 dark:bg-bg lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] lg:p-12">
        {hero}
      </div>

      {/* Right: scrolling panel — identity, mint instrument, record. */}
      <aside className="border-gray-200 px-6 py-8 dark:bg-gray-100 lg:border-l lg:px-8 lg:py-10">
        <section className="space-y-2 border-b border-gray-100 pb-5">
          <nav className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <Link href="/collections" className="hover:text-fg">
              ← Collections
            </Link>
          </nav>
          <h1 className="text-2xl font-medium tracking-tight">{name}</h1>
          {subtitle && <p className="text-base font-medium tracking-tight text-fg-muted">{subtitle}</p>}
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">{byline}</p>
        </section>

        {description && (
          <section className="border-b border-gray-100 py-5 text-sm leading-relaxed text-fg-muted">
            {description}
          </section>
        )}

        <section className="border-b border-gray-100 py-5">{mintInstrument}</section>

        {history}

        {about && <section className="border-b border-gray-100 py-5 text-sm leading-relaxed text-fg-muted">{about}</section>}

        <section className="py-5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[11px] font-mono">
            {facts.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  {f.label}
                </dt>
                <dd className="truncate">{f.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </aside>
    </div>
  )
}
