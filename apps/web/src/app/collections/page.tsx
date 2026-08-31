import type { Metadata } from "next"
import Link from "next/link"
import {
  getSurfaceCollectionCount,
  getSurfaceCollectionSummaries,
  type SurfaceCollectionSummary,
} from "@/lib/indexer-queries"
import {
  SurfaceStatus,
  ZERO_ADDRESS,
  formatPriceLabel,
  hasPriceStrategy,
  lifecycleStatus,
  shortAddress,
  surfaceFactory,
} from "@/lib/collection"
import { CollectionStatusChip } from "@/components/collections/CollectionStatusChip"
import { AvailableArtwork } from "@/components/home/landing-v2/AvailableArtwork"
import { readEnsIdentities } from "@/lib/ens-identity-store"
import { featuredReleaseEditorial } from "@/lib/release-editorial"

export const metadata: Metadata = {
  title: "Releases",
  description:
    "Discover artist-owned releases on PND, then browse the complete permissionless Surface record.",
}

// The mainnet list must validate the live indexer binding at request time.
// Static prerendering would either bake a deployment-time outage into the
// build or fail builds that intentionally have no production DB access.
export const dynamic = "force-dynamic"

const PAGE_SIZE = 24

type CollectionGroup = {
  key: "minting" | "upcoming" | "past" | "record"
  label: string
  items: SurfaceCollectionSummary[]
}

function collectionStatus(
  collection: SurfaceCollectionSummary,
  nowSec: number,
): SurfaceStatus | null {
  if (!collection.saleStateAvailable) return null
  if (!collection.primaryMinter || collection.mintStart === null || collection.mintEnd === null) {
    return SurfaceStatus.Closed
  }
  const exhaustedMinter =
    collection.maxMints !== null &&
    collection.maxMints > 0n &&
    collection.soldThroughMinter >= collection.maxMints
  if (exhaustedMinter) return SurfaceStatus.Closed
  return lifecycleStatus(
    {
      mintStart: BigInt(collection.mintStart),
      mintEnd: BigInt(collection.mintEnd),
      supplyCap: collection.supplyCap,
    },
    collection.mintedEver,
    nowSec,
  )
}

/** Buckets recent collections by derived lifecycle status, leading with
 * actively minting work, then scheduled, then past — same three-way split
 * as OpenSea's Live/Upcoming/Past, restrained to a flat list within each
 * bucket (no pagination, no filters). Section labels only render when more
 * than one bucket is non-empty; a single-bucket listing stays a plain list. */
function groupByLifecycle(
  collections: SurfaceCollectionSummary[],
  nowSec: number,
): CollectionGroup[] {
  const groups: CollectionGroup[] = [
    { key: "minting", label: "Minting now", items: [] },
    { key: "upcoming", label: "Upcoming", items: [] },
    { key: "past", label: "Past", items: [] },
    { key: "record", label: "Release record", items: [] },
  ]
  for (const c of collections) {
    const status = collectionStatus(c, nowSec)
    if (status === SurfaceStatus.Open) groups[0].items.push(c)
    else if (status === SurfaceStatus.Scheduled) groups[1].items.push(c)
    else if (status === SurfaceStatus.Closed) groups[2].items.push(c)
    else groups[3].items.push(c)
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
  let indexUnavailable = false
  let recent: SurfaceCollectionSummary[] = []
  let total = 0
  if (factory) {
    const [indexed, indexedTotal] = await Promise.all([
      getSurfaceCollectionSummaries(PAGE_SIZE, (requestedPage - 1) * PAGE_SIZE),
      getSurfaceCollectionCount(),
    ])
    if (indexed === null || indexedTotal === null) {
      indexUnavailable = true
    } else {
      recent = indexed
      total = indexedTotal
    }
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.min(requestedPage, totalPages)
  const nowSec = Math.floor(Date.now() / 1000)
  const groups = groupByLifecycle(recent, nowSec)
  const showGroupLabels = groups.length > 1
  const identities = await readEnsIdentities(recent.map((item) => item.owner))
  const programmedFeature = featuredReleaseEditorial()
    .map((editorial) => ({
      editorial,
      release: recent.find(
        (candidate) => candidate.collection.toLowerCase() === editorial.collection,
      ),
    }))
    .find((candidate) => candidate.release !== undefined)

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 md:py-16 space-y-12">
      <header className="space-y-5">
        <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          Artist-owned releases
        </p>
        <h1 className="text-3xl md:text-5xl font-semibold tracking-tight">Releases</h1>
        <p className="max-w-2xl text-base text-fg-muted leading-relaxed">
          Art published through Surface contracts owned and operated by artists.
          Browse what is open, what is coming next, and the permanent record of
          releases created with PND.
        </p>
      </header>

      {programmedFeature?.release ? (
        <section aria-labelledby="featured-by-pnd" className="space-y-5">
          <div>
            <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
              PND editorial selection
            </p>
            <h2 id="featured-by-pnd" className="mt-1 text-2xl font-semibold tracking-tight">
              Featured release
            </h2>
          </div>
          <Link
            href={`/collections/${programmedFeature.release.collection}`}
            className="group grid overflow-hidden rounded-md border border-gray-200 bg-surface transition-colors hover:border-gray-400 md:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.7fr)]"
          >
            <div className="aspect-[4/3] overflow-hidden bg-gray-100 md:aspect-auto md:min-h-[360px]">
              <AvailableArtwork
                src={programmedFeature.release.imageUrl}
                alt={programmedFeature.release.name}
              />
            </div>
            <div className="flex flex-col justify-center gap-5 p-6 sm:p-8">
              <div>
                <h3 className="text-2xl font-semibold tracking-tight">
                  {programmedFeature.release.name}
                </h3>
                <p className="mt-2 text-xs font-mono text-gray-500">
                  by {identities.get(programmedFeature.release.owner.toLowerCase())?.ensName ??
                    shortAddress(programmedFeature.release.owner as `0x${string}`)}
                </p>
              </div>
              {programmedFeature.editorial.editorialSummary ? (
                <p className="text-sm leading-relaxed text-fg-muted">
                  {programmedFeature.editorial.editorialSummary}
                </p>
              ) : null}
              <span className="text-xs font-mono underline underline-offset-4">
                Open release
              </span>
            </div>
          </Link>
        </section>
      ) : null}

      {factory === null ? (
        <section className="rounded-lg border border-gray-200 bg-surface p-6">
          <p className="text-sm text-fg-muted leading-relaxed">
            Collections are not yet live on this network. Check back soon.
          </p>
        </section>
      ) : indexUnavailable ? (
        <section className="rounded-lg border border-gray-200 bg-surface p-6 space-y-2">
          <h2 className="text-sm font-medium">Collections temporarily unavailable</h2>
          <p className="text-sm text-fg-muted leading-relaxed">
            PND cannot load the collection list right now. Try again shortly.
          </p>
        </section>
      ) : groups.length > 0 ? (
        <section aria-labelledby="all-surface-releases" className="space-y-12">
          <div>
            <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
              Permissionless record
            </p>
            <h2 id="all-surface-releases" className="mt-1 text-2xl font-semibold tracking-tight">
              All Surface releases
            </h2>
          </div>
          {groups.map((g) => (
            <div key={g.key} className="space-y-4">
              {(showGroupLabels || groups.length === 1) && (
                <h2 className="text-xl font-semibold tracking-tight">
                  {g.label}
                </h2>
              )}
              <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((c) => {
                  const status = collectionStatus(c, nowSec)
                  const soldOut =
                    status === SurfaceStatus.Closed &&
                    ((c.supplyCap > 0n && c.mintedEver >= c.supplyCap) ||
                      (c.maxMints !== null &&
                        c.maxMints > 0n &&
                        c.soldThroughMinter >= c.maxMints))
                  const priceLabel = !c.saleStateAvailable
                    ? null
                    : c.price === null
                      ? "Not currently for sale"
                    : hasPriceStrategy((c.priceStrategy ?? ZERO_ADDRESS) as `0x${string}`)
                      ? "Live price"
                      : formatPriceLabel(c.price)
                  const mintedLabel =
                    c.supplyCap > 0n
                      ? `${Number(c.mintedEver)} / ${Number(c.supplyCap)} minted`
                      : `${Number(c.mintedEver)} minted`
                  const identity = identities.get(c.owner.toLowerCase())
                  const artist = identity?.ensName ?? shortAddress(c.owner as `0x${string}`)
                  const dateSec = c.mintStart && c.mintStart > 0
                    ? c.mintStart
                    : c.createdAtTime
                  const date = dateSec > 0 ? new Date(dateSec * 1000) : null
                  return (
                    <li key={c.collection}>
                      <Link
                        href={`/collections/${c.collection}`}
                        className="group block h-full overflow-hidden rounded-md border border-gray-200 bg-surface hover:border-gray-400 transition-colors"
                      >
                        <div className="aspect-[4/3] overflow-hidden bg-gray-100">
                          <AvailableArtwork src={c.imageUrl} alt={c.name} />
                        </div>
                        <div className="space-y-4 p-4">
                          <div className="flex items-center justify-between gap-3">
                            {status === null ? (
                              <span className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-gray-500">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-300" />
                                Release record
                              </span>
                            ) : (
                              <CollectionStatusChip
                                status={status}
                                soldOut={soldOut}
                                opensInSec={
                                  status === SurfaceStatus.Scheduled
                                    ? (c.mintStart ?? 0) - nowSec
                                    : null
                                }
                              />
                            )}
                            {date ? (
                              <time
                                dateTime={date.toISOString()}
                                className="text-[10px] font-mono text-gray-500"
                              >
                                {date.toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                  timeZone: "UTC",
                                })}
                              </time>
                            ) : null}
                          </div>
                          <div>
                            <h3 className="truncate text-base font-medium tracking-tight">{c.name}</h3>
                            <p className="mt-1 truncate text-xs font-mono text-gray-500">by {artist}</p>
                          </div>
                          <div className="flex items-end justify-between gap-3 border-t border-gray-200 pt-3 text-[11px] font-mono text-gray-500">
                            {priceLabel ? <span>{priceLabel}</span> : null}
                            <span className="ml-auto text-right">{mintedLabel}</span>
                          </div>
                        </div>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </section>
      ) : (
        <section className="rounded-lg border border-gray-200 bg-surface p-6">
          <p className="text-sm text-fg-muted leading-relaxed">
            No collections have been published yet.
          </p>
        </section>
      )}

      {!indexUnavailable && totalPages > 1 ? (
        <nav
          aria-label="Release pages"
          className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-gray-400"
        >
          {currentPage > 1 ? (
            <Link
              href={currentPage - 1 === 1 ? "/collections" : `/collections?page=${currentPage - 1}`}
              className="transition-colors hover:text-fg"
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
              className="transition-colors hover:text-fg"
            >
              Older
            </Link>
          ) : (
            <span className="text-gray-300">Older</span>
          )}
        </nav>
      ) : null}

      <section className="border-t border-gray-200 pt-8">
        <h2 className="text-sm font-medium">The complete Surface record</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted">
          This directory includes every collection observed from the Surface
          factory. Editorial presentation will be clearly marked and will never
          replace this permissionless record. Contract state determines the
          availability labels shown above.
        </p>
      </section>
    </div>
  )
}
