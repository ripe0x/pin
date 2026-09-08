import Link from "next/link"
import type { Address } from "viem"
import { Artwork } from "@/components/media/Artwork"
import { AvailableNow } from "./AvailableNow"
import { getCollection, getRecentCollections } from "@/lib/collection-onchain"
import {
  SurfaceStatus,
  ZERO_ADDRESS,
  formatPriceLabel,
  hasPriceStrategy,
  lifecycleStatus,
  saleWindowOf,
  surfaceFactory,
  type Collection,
} from "@/lib/collection"
import { getCollectionArtwork } from "@/lib/collection-artwork"
import { readEnsIdentities, type StoredEnsIdentity } from "@/lib/ens-identity-store"
import type { DisplayMedia } from "@/lib/display-media"
import {
  featuredReleaseEditorial,
  getReleaseEditorial,
  type ReleaseEditorial,
} from "@/lib/release-editorial"

/**
 * Recent + programmed Surface collections, read the same way `/collections`
 * does: `getRecentCollections` (indexer-backed address list, live per-
 * collection reads underneath) plus a direct `getCollection` for each
 * editorial pick, so a featured release still resolves once it ages out of
 * the recent window.
 */
export async function ReleaseVenue() {
  const factory = surfaceFactory()
  if (!factory) return <AvailableNow />

  const programmedEditorial = featuredReleaseEditorial()
  const [recent, programmed] = await Promise.all([
    getRecentCollections(factory, 18).catch(() => [] as Collection[]),
    Promise.all(
      programmedEditorial.map((entry) =>
        getCollection(entry.collection as Address).catch(() => null),
      ),
    ),
  ])

  const byAddress = new Map<string, Collection>()
  for (const release of [
    ...recent,
    ...programmed.filter((c): c is Collection => c !== null),
  ]) {
    byAddress.set(release.address.toLowerCase(), release)
  }
  const releases = Array.from(byAddress.values())

  if (releases.length === 0) return <AvailableNow />

  const [identities, artwork] = await Promise.all([
    readEnsIdentities(releases.map((r) => r.owner)),
    getCollectionArtwork(releases),
  ])
  const art = (release: Collection): DisplayMedia =>
    artwork.get(release.address.toLowerCase()) ?? { kind: "none" }
  const hasArt = (release: Collection) => art(release).kind !== "none"
  const now = Math.floor(Date.now() / 1000)
  const withStatus = (list: Collection[]) =>
    list.map((release) => ({
      release,
      status: lifecycleStatus(saleWindowOf(release), release.minted, now),
    }))
  const allWithStatus = withStatus(releases)
  const recentWithStatus = withStatus(recent)

  const programmedFeature = programmedEditorial
    .map((editorial) => ({
      editorial,
      item: allWithStatus.find(
        ({ release }) => release.address.toLowerCase() === editorial.collection,
      ),
    }))
    .find((candidate) => candidate.item !== undefined)

  const featured =
    programmedFeature?.item ??
    recentWithStatus.find(
      (item) => item.status === SurfaceStatus.Open && hasArt(item.release),
    ) ??
    recentWithStatus.find(
      (item) => item.status === SurfaceStatus.Scheduled && hasArt(item.release),
    ) ??
    recentWithStatus.find((item) => hasArt(item.release)) ??
    allWithStatus[0]

  const upcoming = recentWithStatus
    .filter(
      (item) =>
        item.release.address !== featured.release.address &&
        item.status === SurfaceStatus.Scheduled,
    )
    .slice(0, 3)
  const recentShelf = recentWithStatus
    .filter(
      (item) =>
        item.release.address !== featured.release.address &&
        item.status !== SurfaceStatus.Scheduled,
    )
    .slice(0, 3)

  return (
    <div className="space-y-20">
      <FeaturedRelease
        release={featured.release}
        artwork={art(featured.release)}
        status={featured.status}
        identity={identities.get(featured.release.owner.toLowerCase())}
        editorial={
          programmedFeature?.editorial ?? getReleaseEditorial(featured.release.address)
        }
        isProgrammedFeature={programmedFeature !== undefined}
        now={now}
      />

      {upcoming.length > 0 ? (
        <ReleaseShelf
          id="upcoming"
          eyebrow="On the calendar"
          title="Upcoming"
          items={upcoming}
          identities={identities}
          artwork={artwork}
          now={now}
        />
      ) : null}

      <AvailableNow />

      {recentShelf.length > 0 ? (
        <ReleaseShelf
          id="recent-releases"
          eyebrow="The release record"
          title="Recent releases"
          items={recentShelf}
          identities={identities}
          artwork={artwork}
          now={now}
        />
      ) : null}
    </div>
  )
}

function FeaturedRelease({
  release,
  artwork,
  status,
  identity,
  editorial,
  isProgrammedFeature,
  now,
}: {
  release: Collection
  artwork: DisplayMedia
  status: SurfaceStatus
  identity?: StoredEnsIdentity
  editorial: ReleaseEditorial | null
  isProgrammedFeature: boolean
  now: number
}) {
  return (
    <section aria-labelledby="featured-release" className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
            {isProgrammedFeature ? "Featured release" : "Latest release"}
          </p>
          <h2 id="featured-release" className="mt-1 text-2xl font-semibold tracking-tight">
            {release.name}
          </h2>
        </div>
        <Link href="/collections" className="text-xs font-mono underline underline-offset-4">
          All releases
        </Link>
      </div>

      <Link
        href={`/collections/${release.address}`}
        className="group grid overflow-hidden rounded-md border border-gray-200 bg-surface transition-colors hover:border-gray-400 md:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.65fr)]"
      >
        <div className="aspect-[4/3] overflow-hidden bg-gray-100 md:aspect-auto md:min-h-[440px]">
          <Artwork media={artwork} alt={release.name} />
        </div>
        <div className="flex flex-col justify-between gap-10 p-6 sm:p-8">
          <div className="space-y-5">
            <ReleaseState status={status} release={release} now={now} />
            <div>
              <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">{release.name}</h3>
              <p className="mt-2 text-sm font-mono text-gray-500">
                by {artistLabel(release.owner, identity)}
              </p>
            </div>
            <p className="text-sm leading-relaxed text-fg-muted">
              {editorial?.editorialSummary ??
                "A release on an artist-owned Surface contract. Open the release page for the artwork, schedule, mint terms, and permanent contract record."}
            </p>
          </div>
          <ReleaseFacts release={release} />
        </div>
      </Link>
    </section>
  )
}

function ReleaseShelf({
  id,
  eyebrow,
  title,
  items,
  identities,
  artwork,
  now,
}: {
  id: string
  eyebrow: string
  title: string
  items: Array<{ release: Collection; status: SurfaceStatus }>
  identities: Map<string, StoredEnsIdentity>
  artwork: Map<string, DisplayMedia>
  now: number
}) {
  return (
    <section aria-labelledby={id} className="space-y-5">
      <div>
        <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          {eyebrow}
        </p>
        <h2 id={id} className="mt-1 text-2xl font-semibold tracking-tight">{title}</h2>
      </div>
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(({ release, status }) => (
          <li key={release.address}>
            <Link
              href={`/collections/${release.address}`}
              className="group block h-full overflow-hidden rounded-md border border-gray-200 bg-surface transition-colors hover:border-gray-400"
            >
              <div className="aspect-[4/3] overflow-hidden bg-gray-100">
                <Artwork
                  media={artwork.get(release.address.toLowerCase()) ?? { kind: "none" }}
                  alt={release.name}
                />
              </div>
              <div className="space-y-4 p-4">
                <ReleaseState status={status} release={release} now={now} />
                <div>
                  <h3 className="truncate text-base font-medium tracking-tight">{release.name}</h3>
                  <p className="mt-1 truncate text-xs font-mono text-gray-500">
                    by {artistLabel(release.owner, identities.get(release.owner.toLowerCase()))}
                  </p>
                </div>
                <ReleaseFacts release={release} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ReleaseState({
  status,
  release,
  now,
}: {
  status: SurfaceStatus
  release: Collection
  now: number
}) {
  const window = saleWindowOf(release)
  const label =
    status === SurfaceStatus.Open
      ? "Available now"
      : status === SurfaceStatus.Scheduled
        ? `Opens ${formatRelative(Number(window.mintStart) - now)}`
        : "Released"
  const dateSec = window.mintStart > 0n ? Number(window.mintStart) : null

  return (
    <div className="flex items-center justify-between gap-3 text-[10px] font-mono uppercase tracking-wider">
      <span className={status === SurfaceStatus.Open ? "text-status-available" : "text-gray-500"}>
        {label}
      </span>
      {dateSec !== null ? (
        <time dateTime={new Date(dateSec * 1000).toISOString()} className="text-gray-500">
          {new Date(dateSec * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          })}
        </time>
      ) : null}
    </div>
  )
}

function ReleaseFacts({ release }: { release: Collection }) {
  const priceStrategy = release.sale?.priceStrategy ?? ZERO_ADDRESS
  const price = hasPriceStrategy(priceStrategy)
    ? "Live price"
    : formatPriceLabel(release.sale?.price ?? 0n)
  const cap = smallestPositive(release.cfg.supplyCap, release.sale?.maxMints ?? 0n)
  const supply = cap > 0n
    ? `${Number(release.minted)} / ${Number(cap)} minted`
    : `${Number(release.minted)} minted`

  return (
    <div className="flex items-end justify-between gap-4 border-t border-gray-200 pt-4 text-[11px] font-mono text-gray-500">
      <span>{price}</span>
      <span className="ml-auto text-right">{supply}</span>
    </div>
  )
}

function artistLabel(address: string, identity?: StoredEnsIdentity): string {
  return identity?.ensName ?? `${address.slice(0, 6)}…${address.slice(-4)}`
}

function smallestPositive(a: bigint, b: bigint): bigint {
  if (a === 0n) return b
  if (b === 0n) return a
  return a < b ? a : b
}

function formatRelative(seconds: number): string {
  if (seconds < 3600) return `in ${Math.max(1, Math.ceil(seconds / 60))}m`
  if (seconds < 86_400) return `in ${Math.ceil(seconds / 3600)}h`
  return `in ${Math.ceil(seconds / 86_400)}d`
}
