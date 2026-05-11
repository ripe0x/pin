import type { Metadata } from "next"
import { Suspense } from "react"
import { redirect } from "next/navigation"
import type { Address } from "viem"
import { resolveEnsAddress } from "@/lib/artist-queries"
import { getDependencyReport } from "@/lib/dependency-check"
import { AddressZorb } from "@/components/AddressZorb"
import { DependencySummary } from "@/components/dependency/DependencySummary"
import { CheckedCard } from "@/components/dependency/CheckedCard"
import { DependencyCard } from "@/components/dependency/DependencyCard"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

type Params = Promise<{ address: string }>

async function resolveParam(raw: string): Promise<string | null> {
  const decoded = decodeURIComponent(raw)
  if (ADDRESS_RE.test(decoded)) return decoded
  const resolved = await resolveEnsAddress(decoded)
  return resolved ?? null
}

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { address: raw } = await params
  const address = await resolveParam(raw)
  if (!address) {
    return {
      title: `Could not resolve "${decodeURIComponent(raw)}"`,
      robots: { index: false, follow: false },
    }
  }

  // Cheap peek at the report to decide whether the page is worth indexing.
  // Reads from the cached wrapper, so this costs at most one Postgres
  // point lookup on warm cache.
  let detected = 0
  try {
    const report = await getDependencyReport(address.toLowerCase())
    detected = report.summary.detected
  } catch {
    // Indexer down → don't index the page at all.
    detected = 0
  }

  const title = `Dependency check`
  const description =
    "What PND can verify about this wallet across supported sources."
  return {
    title,
    description,
    // Same pattern as `/artist/[address]`: search engines walk address
    // links from the activity feed for non-creators; mark zero-result
    // pages noindex so bots stop crawling from them.
    ...(detected === 0 && {
      robots: { index: false, follow: false },
    }),
  }
}

export default async function DependencyResultPage({
  params,
}: {
  params: Params
}) {
  const { address: raw } = await params
  const decoded = decodeURIComponent(raw)
  const address = await resolveParam(raw)

  if (!address) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <h1 className="text-2xl font-semibold">Could not resolve input</h1>
        <p className="text-gray-500 mt-2">
          &ldquo;{decoded}&rdquo; is not a valid Ethereum address or ENS name.
        </p>
        <a
          href="/dependency"
          className="inline-block mt-6 text-sm border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
        >
          Start over
        </a>
      </div>
    )
  }

  // ENS in path → canonical lowercased address. Mirrors `/artist/[address]`.
  if (!ADDRESS_RE.test(decoded)) {
    redirect(`/dependency/${address.toLowerCase()}`)
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      <header className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          Artist dependency scan
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Artist dependency check
        </h1>
      </header>

      <Suspense fallback={<ScanFallback address={address} />}>
        <ScanBody address={address as Address} />
      </Suspense>
    </div>
  )
}

async function ScanBody({ address }: { address: Address }) {
  const report = await getDependencyReport(address.toLowerCase())
  const { identity } = report
  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        {identity.avatarUrl ? (
          <img
            src={identity.avatarUrl}
            alt={identity.displayName}
            className="h-14 w-14 rounded-full object-cover"
          />
        ) : (
          <AddressZorb
            address={identity.address as Address}
            className="h-14 w-14 rounded-full"
          />
        )}
        <div className="min-w-0">
          <div className="text-lg font-semibold truncate">
            {identity.displayName}
          </div>
          <div className="font-mono text-xs text-gray-400">
            {identity.address.slice(0, 6)}...{identity.address.slice(-4)}
          </div>
        </div>
      </div>

      <DependencySummary
        summary={report.summary}
        indexerHealthy={report.indexerHealthy}
      />

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Checked by PND</h2>
          <span className="text-xs text-gray-500">
            {report.checkedCards.length} checks
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3">
          {report.checkedCards.map((c) => (
            <CheckedCard key={c.id} card={c} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Dependency map</h2>
          <span className="text-xs text-gray-500">
            {report.dependencyCards.length} not checked yet
          </span>
        </div>
        <p className="text-sm text-gray-500">
          PND has not verified these dependencies yet. Each card explains
          what would be required to check it.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {report.dependencyCards.map((c) => (
            <DependencyCard key={c.id} card={c} />
          ))}
        </div>
      </section>

      <div className="pt-4 border-t border-gray-100 space-y-1.5 text-xs text-gray-400">
        <p>
          PND only checks supported sources. Not found, Unable to check, and
          Not checked yet do not mean absent everywhere.
        </p>
        <p>
          PND indexes Foundation and Sovereign events from late 2025
          onward. Activity older than the indexer start block is not
          included in this scan.
        </p>
      </div>
    </div>
  )
}

function ScanFallback({ address }: { address: string }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Scanning supported sources for{" "}
        <span className="font-mono">
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        ...
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="border border-gray-200 rounded-md px-4 py-3 h-[68px] animate-pulse"
          />
        ))}
      </div>
    </div>
  )
}
