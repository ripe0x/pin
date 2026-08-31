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
import { AvailableArtwork } from "@/components/home/landing-v2/AvailableArtwork"
import { readEnsIdentities } from "@/lib/ens-identity-store"

export const metadata: Metadata = {
  title: "Releases",
  description:
    "Discover artist-owned releases on PND, then browse the complete permissionless Surface record.",
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
  const identities = await readEnsIdentities(recent.map((item) => item.owner))

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
        <section className="space-y-12">
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
                  const priceLabel = c.price === null
                    ? "Not currently for sale"
                    : hasPriceStrategy((c.priceStrategy ?? ZERO_ADDRESS) as `0x${string}`)
                      ? "Live price"
                      : formatPriceLabel(c.price)
                  const mintedLabel =
                    c.supplyCap > 0n
                      ? `${Number(c.mintedEver)} / ${Number(c.supplyCap)} minted`
                      : `${Number(c.mintedEver)} minted · open`
                  const identity = identities.get(c.owner.toLowerCase())
                  const artist = identity?.ensName ?? shortAddress(c.owner as `0x${string}`)
                  const date = c.mintStart && c.mintStart > 0
                    ? new Date(c.mintStart * 1000)
                    : new Date(c.createdAtTime * 1000)
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
                            <CollectionStatusChip
                              status={status}
                              soldOut={soldOut}
                              opensInSec={
                                status === SurfaceStatus.Scheduled
                                  ? (c.mintStart ?? 0) - nowSec
                                  : null
                              }
                            />
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
                          </div>
                          <div>
                            <h3 className="truncate text-base font-medium tracking-tight">{c.name}</h3>
                            <p className="mt-1 truncate text-xs font-mono text-gray-500">by {artist}</p>
                          </div>
                          <div className="flex items-end justify-between gap-3 border-t border-gray-200 pt-3 text-[11px] font-mono text-gray-500">
                            <span>{priceLabel}</span>
                            <span className="text-right">{mintedLabel}</span>
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

function collectionToSummary(collection: Collection): SurfaceCollectionSummary {
  return {
    collection: collection.address,
    owner: collection.owner,
    name: collection.name,
    symbol: collection.symbol,
    primaryMinter: collection.primaryMinter,
    // A registered primary minter that does not implement the canonical
    // FixedPriceMinter getters is a custom sale surface, not proof that the
    // collection is closed. Preserve the pre-snapshot directory behavior for
    // that bounded compatibility path; the collection page performs its own
    // minter-specific live check before offering a transaction.
    price: collection.sale?.price ?? (collection.primaryMinter ? 0n : null),
    priceStrategy:
      collection.sale?.priceStrategy ??
      (collection.primaryMinter ? ZERO_ADDRESS : null),
    mintStart: collection.sale
      ? Number(collection.sale.mintStart)
      : collection.primaryMinter
        ? 0
        : null,
    mintEnd: collection.sale
      ? Number(collection.sale.mintEnd)
      : collection.primaryMinter
        ? 0
        : null,
    maxMints: collection.sale?.maxMints ?? null,
    supplyCap: collection.cfg.supplyCap,
    mintedEver: collection.minted,
    soldThroughMinter: collection.minted,
    imageUrl: null,
    createdAtTime: 0,
  }
}
