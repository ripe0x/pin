import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { formatEther } from "viem"
import { LatestActivity } from "@/components/home/landing-v2/LatestActivity"
import { LandingProfileSearch } from "@/components/home/landing-v2/ProfileSearch"
import { ReleaseVenue } from "@/components/home/landing-v2/ReleaseVenue"
import { getPlatformStats } from "@/lib/indexer-queries"

export const metadata: Metadata = {
  title: "Artist-owned releases",
  description:
    "PND is a venue for artist-owned releases, portable release infrastructure, and a durable public record on Ethereum.",
}

export const dynamic = "force-dynamic"

export default function LandingV2Page() {
  return (
    <div className="mx-auto max-w-6xl space-y-20 px-6 py-10 md:py-16">
      <header className="border-b border-gray-200 pb-14">
        <div className="max-w-4xl space-y-7">
          <div className="space-y-4">
            <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
              PND on Ethereum
            </p>
            <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl lg:text-6xl">
              A venue for artist-owned releases.
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-fg-muted sm:text-lg">
              Artists can launch here, operate independently, or use the same
              tools on their own sites. Collect directly, follow each body of
              work, and keep the public record legible beyond one interface.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link
              href="#available-now"
              className="rounded-md bg-fg px-5 py-3 text-center text-xs font-mono font-medium uppercase tracking-wider text-bg transition-opacity hover:opacity-80"
            >
              See what is available
            </Link>
            <Link
              href="/collections"
              className="rounded-md border border-gray-300 px-5 py-3 text-center text-xs font-mono font-medium uppercase tracking-wider transition-colors hover:border-gray-600"
            >
              Browse releases
            </Link>
            <Link
              href="/studio"
              className="px-2 py-3 text-center text-xs font-mono font-medium uppercase tracking-wider text-gray-600 underline underline-offset-4 hover:text-fg"
            >
              For artists: open Studio
            </Link>
          </div>

          <Suspense fallback={null}>
            <PlatformSignals />
          </Suspense>
        </div>
      </header>

      <Suspense fallback={<VenueSkeleton />}>
        <ReleaseVenue />
      </Suspense>

      <div className="grid gap-14 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.55fr)] lg:items-start">
        <Suspense fallback={<ActivitySkeleton />}>
          <LatestActivity />
        </Suspense>

        <aside className="space-y-8 lg:sticky lg:top-24">
          <div className="space-y-3">
            <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
              A durable public record
            </p>
            <h2 className="text-xl font-semibold tracking-tight">The work remains connected</h2>
            <p className="text-sm leading-relaxed text-fg-muted">
              Profiles keep available, created, sold, and collected work distinct,
              without forcing people who are both artists and collectors into one role.
            </p>
          </div>
          <div className="space-y-3 border-t border-gray-200 pt-7">
            <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
              Collectors, artists, curators
            </p>
            <p className="text-sm leading-relaxed text-fg-muted">
              Follow what is available, understand what an artist has already made,
              and trace how work moves between people without turning those roles
              into separate identities.
            </p>
            <Link href="/catalog" className="inline-block text-xs font-mono underline underline-offset-4">
              Explore the Catalog
            </Link>
          </div>
        </aside>
      </div>

      <section aria-labelledby="why-pnd" className="grid gap-10 border-y border-gray-200 py-12 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <div className="space-y-6">
          <div className="max-w-2xl space-y-2">
            <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
              Portable by design
            </p>
            <h2 id="why-pnd" className="text-2xl font-semibold tracking-tight sm:text-3xl">
              The release does not depend on PND remaining its primary interface.
            </h2>
          </div>
          <div className="grid gap-8 md:grid-cols-3">
            <Proof
              number="01"
              title="Artist-owned contracts"
              body="Artists control the contracts, sale terms, and payout paths around their work."
            />
            <Proof
              number="02"
              title="A shared release system"
              body="PND and artist-run interfaces can use the same release, mint, and rendering tools."
            />
            <Proof
              number="03"
              title="An exit door, not a badge"
              body="Artists may export or self-host without PND pretending to monitor or certify what happens next."
            />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-mono">
            <Link href="/about" className="underline underline-offset-4">How PND works</Link>
            <Link href="/preserve" className="underline underline-offset-4">Preserve work</Link>
            <Link href="/sites" className="underline underline-offset-4">Site tools</Link>
          </div>
        </div>

        <aside className="rounded-md border border-gray-200 bg-gray-50 p-5 sm:p-6">
          <LandingProfileSearch />
          <p className="mt-6 border-t border-gray-200 pt-5 text-xs leading-relaxed text-gray-600">
            Find the permanent record for an artist, collector, or address.
            Created work and collected work stay distinct on the same profile.
          </p>
        </aside>
      </section>
    </div>
  )
}

async function PlatformSignals() {
  const stats = await getPlatformStats().catch(() => null)
  if (!stats) return null
  const eth = Number(formatEther(stats.ethToArtistsWei))
  const values = [
    { value: stats.housesDeployed.toLocaleString("en-US"), label: "artist-owned auction houses" },
    { value: stats.collectionsDeployed.toLocaleString("en-US"), label: "PND Surface collections" },
    { value: `${eth.toLocaleString("en-US", { maximumFractionDigits: 3 })} ETH`, label: "paid directly to artists" },
    { value: "0%", label: "PND platform fee on auctions" },
  ]
  return (
    <dl className="grid max-w-3xl grid-cols-2 gap-x-6 gap-y-4 pt-2 sm:grid-cols-4">
      {values.map((item) => (
        <div key={item.label}>
          <dt className="text-xs leading-snug text-gray-500">{item.label}</dt>
          <dd className="mb-1 text-lg font-medium tabular-nums sm:order-first">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Proof({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <article className="space-y-3">
      <p className="text-[10px] font-mono text-gray-500">{number}</p>
      <h3 className="text-base font-medium">{title}</h3>
      <p className="text-sm leading-relaxed text-fg-muted">{body}</p>
    </article>
  )
}

function VenueSkeleton() {
  return (
    <section className="space-y-5" aria-label="Loading releases">
      <div className="h-8 w-56 skeleton rounded-sm" />
      <div className="aspect-[16/9] skeleton rounded-md md:aspect-[2/1]" />
    </section>
  )
}

function ActivitySkeleton() {
  return (
    <section className="space-y-4" aria-label="Loading activity">
      <div className="h-8 w-56 skeleton rounded-sm" />
      <div className="h-72 skeleton rounded-md" />
    </section>
  )
}
