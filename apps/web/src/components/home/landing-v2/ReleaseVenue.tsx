import Link from "next/link"
import { AuctionPanel } from "@/components/auction/AuctionPanel"
import { Artwork } from "@/components/media/Artwork"
import { SurfaceStatus } from "@/lib/collection"
import {
  getFeaturedAuction,
  type AuctionShelfCard,
} from "@/lib/landing-auctions"
import type { AuctionState } from "@/lib/auctions"
import {
  getVenueModel,
  venueStatus,
  type VenueRelease,
} from "@/lib/landing-venue"

export async function ReleaseVenue({ part }: { part: "featured" | "recent" }) {
  const model = await getVenueModel().catch(() => null)
  const now = Math.floor(Date.now() / 1000)

  if (part === "recent") {
    return model && model.recent.length > 0 ? (
      <ReleaseShelf
        id="recent-releases"
        eyebrow="The release record"
        title="Recent releases"
        items={model.recent}
        now={now}
      />
    ) : null
  }

  // The hero prefers a live auction (top bidding lot) over the Surface
  // release, falling back to the release when nothing is actively bidding.
  const featuredAuction = await getFeaturedAuction().catch(() => null)
  if (!featuredAuction && !model) return null

  return (
    <div className="space-y-20">
      {featuredAuction ? (
        <FeaturedAuction card={featuredAuction.card} auction={featuredAuction.auction} />
      ) : model ? (
        <FeaturedRelease release={model.featured} now={now} />
      ) : null}
      {model && model.upcoming.length > 0 ? (
        <ReleaseShelf
          id="upcoming"
          eyebrow="On the calendar"
          title="Upcoming"
          items={model.upcoming}
          now={now}
        />
      ) : null}
    </div>
  )
}

function FeaturedAuction({
  card,
  auction,
}: {
  card: AuctionShelfCard
  auction: AuctionState
}) {
  const title = card.title ?? `Token #${card.tokenId}`
  const tokenHref = `/${card.tokenContract}/${card.tokenId}`
  return (
    <section aria-labelledby="featured-auction" className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-status-available">
            Live auction
          </p>
          <h2 id="featured-auction" className="mt-1 text-2xl font-semibold tracking-tight">
            {title}
          </h2>
        </div>
        <Link href="/auctions" className="text-xs font-mono underline underline-offset-4">
          All auctions
        </Link>
      </div>
      <div className="grid overflow-hidden rounded-md border border-gray-200 bg-surface md:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.65fr)]">
        <Link href={tokenHref} className="block aspect-square overflow-hidden bg-gray-100">
          <Artwork media={card.artwork} alt={title} />
        </Link>
        <div className="flex flex-col gap-6 p-6 sm:p-8">
          <div>
            <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              <Link href={tokenHref} className="hover:underline">
                {title}
              </Link>
            </h3>
            <p className="mt-2 text-sm font-mono text-gray-500">by {card.sellerLabel}</p>
          </div>
          <AuctionPanel auction={auction} />
        </div>
      </div>
    </section>
  )
}

function FeaturedRelease({
  release,
  now,
}: {
  release: VenueRelease & { summary: string | null; programmed: boolean }
  now: number
}) {
  return (
    <section aria-labelledby="featured-release" className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
            {release.programmed ? "Featured release" : "Latest release"}
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
        <div className="aspect-square overflow-hidden bg-gray-100">
          <Artwork media={release.artwork} alt={release.name} />
        </div>
        <div className="flex flex-col justify-between gap-10 p-6 sm:p-8">
          <div className="space-y-5">
            <ReleaseState release={release} now={now} />
            <div>
              <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">{release.name}</h3>
              <p className="mt-2 text-sm font-mono text-gray-500">by {release.artistLabel}</p>
            </div>
            <p className="text-sm leading-relaxed text-fg-muted">
              {release.summary ??
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
  now,
}: {
  id: string
  eyebrow: string
  title: string
  items: VenueRelease[]
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
        {items.map((release) => (
          <li key={release.address}>
            <Link
              href={`/collections/${release.address}`}
              className="group block h-full overflow-hidden rounded-md border border-gray-200 bg-surface transition-colors hover:border-gray-400"
            >
              <div className="aspect-square overflow-hidden bg-gray-100">
                <Artwork media={release.artwork} alt={release.name} />
              </div>
              <div className="space-y-4 p-4">
                <ReleaseState release={release} now={now} />
                <div>
                  <h3 className="truncate text-base font-medium tracking-tight">{release.name}</h3>
                  <p className="mt-1 truncate text-xs font-mono text-gray-500">
                    by {release.artistLabel}
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

function ReleaseState({ release, now }: { release: VenueRelease; now: number }) {
  const status = venueStatus(release, now)
  const label =
    status === SurfaceStatus.Open
      ? "Available now"
      : status === SurfaceStatus.Scheduled
        ? `Opens ${formatRelative(release.mintStart - now)}`
        : "Released"
  const dateSec = release.mintStart > 0 ? release.mintStart : null

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

function ReleaseFacts({ release }: { release: VenueRelease }) {
  const cap = BigInt(release.cap)
  const minted = BigInt(release.minted)
  const supply = cap > 0n
    ? `${minted} / ${cap} minted`
    : `${minted} minted`

  return (
    <div className="flex items-end justify-between gap-4 border-t border-gray-200 pt-4 text-[11px] font-mono text-gray-500">
      <span>{release.priceLabel}</span>
      <span className="ml-auto text-right">{supply}</span>
    </div>
  )
}

function formatRelative(seconds: number): string {
  if (seconds < 3600) return `in ${Math.max(1, Math.ceil(seconds / 60))}m`
  if (seconds < 86_400) return `in ${Math.ceil(seconds / 3600)}h`
  return `in ${Math.ceil(seconds / 86_400)}d`
}
