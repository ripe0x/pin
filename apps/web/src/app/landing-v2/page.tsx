import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { formatEther } from "viem"
import { AvailableNow } from "@/components/home/landing-v2/AvailableNow"
import { LatestActivity } from "@/components/home/landing-v2/LatestActivity"
import { LandingProfileSearch } from "@/components/home/landing-v2/ProfileSearch"
import { getPlatformStats } from "@/lib/indexer-queries"

export const metadata: Metadata = {
  title: "Landing v2",
  description:
    "Discover and collect directly from independent artists using artist-owned infrastructure on Ethereum.",
}

export const dynamic = "force-dynamic"

export default function LandingV2Page() {
  return (
    <div className="mx-auto max-w-6xl space-y-20 px-6 py-10 md:py-16">
      <header className="grid gap-10 border-b border-gray-200 pb-14 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.75fr)] lg:items-end">
        <div className="space-y-7">
          <div className="space-y-4">
            <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
              Artist-owned infrastructure
            </p>
            <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl lg:text-6xl">
              Discover and collect directly from independent artists.
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-fg-muted sm:text-lg">
              PND connects artist-owned contracts, auctions, collections,
              Catalog declarations, and preservation records across Ethereum.
              The work stays connected to the artist, not to one marketplace.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link
              href="#available-now"
              className="rounded-md bg-fg px-5 py-3 text-center text-xs font-mono font-medium uppercase tracking-wider text-bg transition-opacity hover:opacity-80"
            >
              Explore available work
            </Link>
            <Link
              href="/catalog"
              className="rounded-md border border-gray-300 px-5 py-3 text-center text-xs font-mono font-medium uppercase tracking-wider transition-colors hover:border-gray-600"
            >
              Browse artist records
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

        <aside className="rounded-md border border-gray-200 bg-gray-50 p-5 sm:p-6">
          <LandingProfileSearch />
          <div className="mt-6 border-t border-gray-200 pt-5">
            <p className="text-xs leading-relaxed text-gray-600">
              A PND profile brings together created work, current ownership,
              and sale activity without forcing artists and collectors into
              separate identities.
            </p>
          </div>
        </aside>
      </header>

      <Suspense fallback={<AvailableSkeleton />}>
        <AvailableNow />
      </Suspense>

      <section aria-labelledby="why-pnd" className="space-y-6 border-y border-gray-200 py-12">
        <div className="max-w-2xl space-y-2">
          <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
            The layer underneath platforms
          </p>
          <h2 id="why-pnd" className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Built for work that should outlast an interface.
          </h2>
        </div>
        <div className="grid gap-8 md:grid-cols-3">
          <Proof
            number="01"
            title="Artist-owned infrastructure"
            body="Artists can own the contracts and sites around their work. PND remains an interface, not a gatekeeper."
          />
          <Proof
            number="02"
            title="One creative record"
            body="Created work, collected work, releases, sales, and attribution can coexist on one address without forcing a single role."
          />
          <Proof
            number="03"
            title="Portable provenance"
            body="Catalog declarations and preservation signals keep the relationship between artist and work legible beyond one marketplace."
          />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-mono">
          <Link href="/about" className="underline underline-offset-4">What PND is</Link>
          <Link href="/preserve" className="underline underline-offset-4">Preserve work</Link>
          <Link href="/sites" className="underline underline-offset-4">Artist-owned sites</Link>
        </div>
      </section>

      <div className="grid gap-14 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.55fr)] lg:items-start">
        <Suspense fallback={<ActivitySkeleton />}>
          <LatestActivity />
        </Suspense>

        <aside className="space-y-8 lg:sticky lg:top-24">
          <div className="space-y-3">
            <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
              Start with the work
            </p>
            <h2 className="text-xl font-semibold tracking-tight">Available comes first</h2>
            <p className="text-sm leading-relaxed text-fg-muted">
              Explore open releases and auctions first, then move into an
              artist&apos;s profile to understand the larger body of work,
              including what has sold and what they collect.
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

function AvailableSkeleton() {
  return (
    <section className="space-y-5" aria-label="Loading available work">
      <div className="h-8 w-48 skeleton rounded-sm" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="aspect-[4/3] skeleton rounded-md" />
        ))}
      </div>
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
