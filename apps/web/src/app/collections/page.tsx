import type { Metadata } from "next"
import Link from "next/link"
import { getCollectionsPage } from "@/lib/collection-onchain"
import {
  SurfaceStatus,
  ZERO_ADDRESS,
  formatPriceLabel,
  hasPriceStrategy,
  lifecycleStatus,
  saleWindowOf,
  shortAddress,
  surfaceFactory,
  type Collection,
} from "@/lib/collection"
import { CollectionStatusChip } from "@/components/collections/CollectionStatusChip"

export const metadata: Metadata = {
  title: "Collections",
  description:
    "Release onchain art as sovereign collections you own. Every token keeps its own identity and onchain Mint Mark. Mainnet only. Honest pricing.",
}

export const revalidate = 3600

/** Collections per index page. The list path is a pure SELECT (indexed
 * SurfaceCreated table, OFFSET/LIMIT) plus one COUNT; live per-collection
 * state stays behind getCollection()'s cached reads. Search is deferred
 * until the collection count warrants it; it would slot in as a WHERE
 * clause on the same discovery query. */
const PAGE_SIZE = 24

type CollectionGroup = {
  key: "minting" | "upcoming" | "past"
  label: string
  items: Collection[]
}

/** Buckets a page of collections by derived lifecycle status, leading with
 * actively minting work, then scheduled, then past. Bucketing is applied
 * within the current page only, so a page can carry fewer than PAGE_SIZE
 * across three sections; the newest-first order the index paginates on is
 * preserved inside each bucket. Section labels only render when more than
 * one bucket is non-empty; a single-bucket listing stays a plain list. */
function groupByLifecycle(collections: Collection[], nowSec: number): CollectionGroup[] {
  const groups: CollectionGroup[] = [
    { key: "minting", label: "Minting now", items: [] },
    { key: "upcoming", label: "Upcoming", items: [] },
    { key: "past", label: "Past", items: [] },
  ]
  for (const c of collections) {
    const status = lifecycleStatus(saleWindowOf(c), c.minted, nowSec)
    if (status === SurfaceStatus.Open) groups[0].items.push(c)
    else if (status === SurfaceStatus.Scheduled) groups[1].items.push(c)
    else groups[2].items.push(c)
  }
  return groups.filter((g) => g.items.length > 0)
}

export default async function CollectionsHome({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const factory = surfaceFactory()
  const { page: pageParam } = await searchParams
  const requestedPage = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1)
  const pageData = factory
    ? await getCollectionsPage(factory, requestedPage, PAGE_SIZE)
    : { collections: [], total: 0, page: requestedPage, pageSize: PAGE_SIZE }
  const totalPages = Math.max(1, Math.ceil(pageData.total / PAGE_SIZE))
  const currentPage = Math.min(pageData.page, totalPages)
  const nowSec = Math.floor(Date.now() / 1000)
  const groups = groupByLifecycle(pageData.collections, nowSec)
  const showGroupLabels = groups.length > 1

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 md:py-16 space-y-12">
      <header className="space-y-5">
        <h1 className="text-2xl md:text-3xl font-medium tracking-tight">Collections</h1>
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
      ) : groups.length > 0 ? (
        <section className="space-y-8">
          {groups.map((g) => (
            <div key={g.key} className="space-y-4">
              {showGroupLabels && (
                <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  {g.label}
                </h2>
              )}
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {g.items.map((c) => {
                  const window = saleWindowOf(c)
                  const status = lifecycleStatus(window, c.minted, nowSec)
                  const soldOut =
                    status === SurfaceStatus.Closed &&
                    c.cfg.supplyCap > 0n &&
                    c.minted >= c.cfg.supplyCap
                  const priceLabel = hasPriceStrategy(c.sale?.priceStrategy ?? ZERO_ADDRESS)
                    ? "Live price"
                    : formatPriceLabel(c.sale?.price ?? 0n)
                  const mintedLabel =
                    c.cfg.supplyCap > 0n
                      ? `${Number(c.minted)} / ${Number(c.cfg.supplyCap)} minted`
                      : `${Number(c.minted)} minted · open`
                  return (
                    <li key={c.address}>
                      <Link
                        href={`/collections/${c.address}`}
                        className="block rounded-lg border border-gray-200 bg-surface p-4 hover:border-gray-300 transition-colors"
                      >
                        <p className="text-sm font-medium tracking-tight truncate">{c.name}</p>
                        <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                          {c.symbol} · {shortAddress(c.address)}
                        </p>
                        <div className="mt-2">
                          <CollectionStatusChip
                            status={status}
                            soldOut={soldOut}
                            opensInSec={
                              status === SurfaceStatus.Scheduled
                                ? Number(window.mintStart) - nowSec
                                : null
                            }
                          />
                        </div>
                        <p className="mt-2 text-[10px] font-mono text-gray-500 tabular-nums">
                          {priceLabel} · {mintedLabel}
                        </p>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {totalPages > 1 && (
        <nav
          aria-label="Collections pages"
          className="flex items-center justify-between pt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400"
        >
          {currentPage > 1 ? (
            <Link
              href={
                currentPage - 1 === 1
                  ? "/collections"
                  : `/collections?page=${currentPage - 1}`
              }
              className="hover:text-fg transition-colors"
            >
              Newer
            </Link>
          ) : (
            <span className="text-gray-300">Newer</span>
          )}
          <span className="tabular-nums text-gray-500">
            Page {currentPage} of {totalPages}
          </span>
          {currentPage < totalPages ? (
            <Link
              href={`/collections?page=${currentPage + 1}`}
              className="hover:text-fg transition-colors"
            >
              Older
            </Link>
          ) : (
            <span className="text-gray-300">Older</span>
          )}
        </nav>
      )}
    </div>
  )
}
