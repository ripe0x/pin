import type { Metadata } from "next"
import Link from "next/link"
import { getRecentCollections } from "@/lib/collection-onchain"
import {
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
  type Collection,
} from "@/lib/collection"
import { CollectionStatusChip } from "@/components/collections/CollectionStatusChip"

export const metadata: Metadata = {
  title: "Collections",
  description:
    "Release onchain art as sovereign collections you own. Every token keeps its own identity. Mainnet only. Honest pricing.",
}

// The mainnet list must validate the live indexer binding at request time.
// Static prerendering would either bake a deployment-time outage into the
// build or fail builds that intentionally have no production DB access.
export const dynamic = "force-dynamic"

type CollectionGroup = {
  key: "minting" | "upcoming" | "past"
  label: string
  items: SurfaceCollectionSummary[]
}

function collectionStatus(
  collection: SurfaceCollectionSummary,
  nowSec: number,
): SurfaceStatus {
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
  ]
  for (const c of collections) {
    const status = collectionStatus(c, nowSec)
    if (status === SurfaceStatus.Open) groups[0].items.push(c)
    else if (status === SurfaceStatus.Scheduled) groups[1].items.push(c)
    else groups[2].items.push(c)
  }
  return groups.filter((g) => g.items.length > 0)
}

export default async function CollectionsHome() {
  const factory = surfaceFactory()
  let indexUnavailable = false
  let recent: SurfaceCollectionSummary[] = []
  if (factory) {
    const indexed = await getSurfaceCollectionSummaries(8)
    if (indexed === null) {
      try {
        recent = (await getRecentCollections(factory, 8)).map(collectionToSummary)
      } catch {
        indexUnavailable = true
      }
    } else {
      recent = indexed
    }
  }
  const nowSec = Math.floor(Date.now() / 1000)
  const groups = groupByLifecycle(recent, nowSec)
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
          <li>Per-token identity</li>
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
      ) : indexUnavailable ? (
        <section className="rounded-lg border border-gray-200 bg-surface p-6 space-y-2">
          <h2 className="text-sm font-medium">Collections temporarily unavailable</h2>
          <p className="text-sm text-fg-muted leading-relaxed">
            PND cannot load the collection list right now. Try again shortly.
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
                  const status = collectionStatus(c, nowSec)
                  const soldOut =
                    status === SurfaceStatus.Closed &&
                    ((c.supplyCap > 0n && c.mintedEver >= c.supplyCap) ||
                      (c.maxMints !== null &&
                        c.maxMints > 0n &&
                        c.soldThroughMinter >= c.maxMints))
                  const priceLabel = c.price === null
                    ? "Not currently for sale"
                    : hasPriceStrategy((c.priceStrategy ?? ZERO_ADDRESS) as `0x${string}`)
                      ? "Live price"
                      : formatPriceLabel(c.price)
                  const mintedLabel =
                    c.supplyCap > 0n
                      ? `${Number(c.mintedEver)} / ${Number(c.supplyCap)} minted`
                      : `${Number(c.mintedEver)} minted · open`
                  return (
                    <li key={c.collection}>
                      <Link
                        href={`/collections/${c.collection}`}
                        className="block rounded-lg border border-gray-200 bg-surface p-4 hover:border-gray-300 transition-colors"
                      >
                        <p className="text-sm font-medium tracking-tight truncate">{c.name}</p>
                        <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                          {c.symbol} · {shortAddress(c.collection as `0x${string}`)}
                        </p>
                        <div className="mt-2">
                          <CollectionStatusChip
                            status={status}
                            soldOut={soldOut}
                            opensInSec={
                              status === SurfaceStatus.Scheduled
                                ? (c.mintStart ?? 0) - nowSec
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
      ) : (
        <section className="rounded-lg border border-gray-200 bg-surface p-6">
          <p className="text-sm text-fg-muted leading-relaxed">
            No collections have been published yet.
          </p>
        </section>
      )}
    </div>
  )
}

function collectionToSummary(collection: Collection): SurfaceCollectionSummary {
  return {
    collection: collection.address,
    owner: collection.owner,
    name: collection.name,
    symbol: collection.symbol,
    primaryMinter: collection.primaryMinter,
    price: collection.sale?.price ?? null,
    priceStrategy: collection.sale?.priceStrategy ?? null,
    mintStart: collection.sale ? Number(collection.sale.mintStart) : null,
    mintEnd: collection.sale ? Number(collection.sale.mintEnd) : null,
    maxMints: collection.sale?.maxMints ?? null,
    supplyCap: collection.cfg.supplyCap,
    mintedEver: collection.minted,
    soldThroughMinter: collection.minted,
  }
}
