import Link from "next/link"
import { AvailableArtwork } from "./AvailableArtwork"
import { AvailableNow } from "./AvailableNow"
import {
  SurfaceStatus,
  formatPriceLabel,
  hasPriceStrategy,
  lifecycleStatus,
} from "@/lib/collection"
import {
  getSurfaceCollectionSummaries,
  type SurfaceCollectionSummary,
} from "@/lib/indexer-queries"
import { readEnsIdentities, type StoredEnsIdentity } from "@/lib/ens-identity-store"

export async function ReleaseVenue() {
  const releases = await getSurfaceCollectionSummaries(18).catch(() => null)

  if (!releases?.length) {
    return <AvailableNow />
  }

  const identities = await readEnsIdentities(releases.map((release) => release.owner))
  const now = Math.floor(Date.now() / 1000)
  const withStatus = releases.map((release) => ({
    release,
    status: releaseStatus(release, now),
  }))
  const featured =
    withStatus.find((item) => item.status === SurfaceStatus.Open && item.release.imageUrl) ??
    withStatus.find((item) => item.status === SurfaceStatus.Scheduled && item.release.imageUrl) ??
    withStatus.find((item) => item.release.imageUrl) ??
    withStatus[0]
  const upcoming = withStatus
    .filter(
      (item) =>
        item.release.collection !== featured.release.collection &&
        item.status === SurfaceStatus.Scheduled,
    )
    .slice(0, 3)
  const recent = withStatus
    .filter(
      (item) =>
        item.release.collection !== featured.release.collection &&
        item.status !== SurfaceStatus.Scheduled,
    )
    .slice(0, 3)

  return (
    <div className="space-y-20">
      <FeaturedRelease
        release={featured.release}
        status={featured.status}
        identity={identities.get(featured.release.owner.toLowerCase())}
        now={now}
      />

      {upcoming.length > 0 ? (
        <ReleaseShelf
          id="upcoming"
          eyebrow="On the calendar"
          title="Upcoming"
          items={upcoming}
          identities={identities}
          now={now}
        />
      ) : null}

      <AvailableNow />

      {recent.length > 0 ? (
        <ReleaseShelf
          id="recent-releases"
          eyebrow="The release record"
          title="Recent releases"
          items={recent}
          identities={identities}
          now={now}
        />
      ) : null}
    </div>
  )
}

function FeaturedRelease({
  release,
  status,
  identity,
  now,
}: {
  release: SurfaceCollectionSummary
  status: SurfaceStatus
  identity?: StoredEnsIdentity
  now: number
}) {
  return (
    <section aria-labelledby="featured-release" className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
            Featured release
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
        href={`/collections/${release.collection}`}
        className="group grid overflow-hidden rounded-md border border-gray-200 bg-surface transition-colors hover:border-gray-400 md:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.65fr)]"
      >
        <div className="aspect-[4/3] overflow-hidden bg-gray-100 md:aspect-auto md:min-h-[440px]">
          <AvailableArtwork src={release.imageUrl} alt={release.name} />
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
              A release on an artist-owned Surface contract. Open the release
              page for the artwork, schedule, mint terms, and permanent contract record.
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
  now,
}: {
  id: string
  eyebrow: string
  title: string
  items: Array<{ release: SurfaceCollectionSummary; status: SurfaceStatus }>
  identities: Map<string, StoredEnsIdentity>
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
          <li key={release.collection}>
            <Link
              href={`/collections/${release.collection}`}
              className="group block h-full overflow-hidden rounded-md border border-gray-200 bg-surface transition-colors hover:border-gray-400"
            >
              <div className="aspect-[4/3] overflow-hidden bg-gray-100">
                <AvailableArtwork src={release.imageUrl} alt={release.name} />
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
  release: SurfaceCollectionSummary
  now: number
}) {
  const label =
    status === SurfaceStatus.Open
      ? "Available now"
      : status === SurfaceStatus.Scheduled
        ? `Opens ${formatRelative((release.mintStart ?? now) - now)}`
        : "Released"
  const dateSec = release.mintStart && release.mintStart > 0
    ? release.mintStart
    : release.createdAtTime

  return (
    <div className="flex items-center justify-between gap-3 text-[10px] font-mono uppercase tracking-wider">
      <span className={status === SurfaceStatus.Open ? "text-status-available" : "text-gray-500"}>
        {label}
      </span>
      {dateSec > 0 ? (
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

function ReleaseFacts({ release }: { release: SurfaceCollectionSummary }) {
  const dynamicPrice =
    release.priceStrategy !== null &&
    hasPriceStrategy(release.priceStrategy as `0x${string}`)
  const price =
    release.price === null
      ? "Not for sale"
      : dynamicPrice
        ? "Live price"
        : formatPriceLabel(release.price)
  const cap = smallestPositive(release.supplyCap, release.maxMints ?? 0n)
  const used = release.maxMints && release.maxMints > 0n
    ? release.soldThroughMinter
    : release.mintedEver
  const supply = cap > 0n ? `${used} / ${cap} minted` : `${used} minted`

  return (
    <div className="flex items-end justify-between gap-4 border-t border-gray-200 pt-4 text-[11px] font-mono text-gray-500">
      <span>{price}</span>
      <span className="text-right">{supply}</span>
    </div>
  )
}

function releaseStatus(release: SurfaceCollectionSummary, now: number): SurfaceStatus {
  if (!release.primaryMinter || release.mintStart === null || release.mintEnd === null) {
    return SurfaceStatus.Closed
  }
  const soldOut =
    (release.supplyCap > 0n && release.mintedEver >= release.supplyCap) ||
    (release.maxMints !== null &&
      release.maxMints > 0n &&
      release.soldThroughMinter >= release.maxMints)
  if (soldOut) return SurfaceStatus.Closed
  return lifecycleStatus(
    {
      mintStart: BigInt(release.mintStart),
      mintEnd: BigInt(release.mintEnd),
      supplyCap: release.supplyCap,
    },
    release.mintedEver,
    now,
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
