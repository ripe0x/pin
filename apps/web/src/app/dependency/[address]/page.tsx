import type { Metadata } from "next"
import { Suspense } from "react"
import { redirect } from "next/navigation"
import type { Address } from "viem"
import { resolveEnsAddress } from "@/lib/artist-queries"
import { getDependencyReport } from "@/lib/dependency-check"
import { AddressZorb } from "@/components/AddressZorb"
import { InventoryTotals } from "@/components/dependency/InventoryTotals"
import { ContractMapTable } from "@/components/dependency/ContractMapTable"
import { DependencyReadCard } from "@/components/dependency/DependencyReadCard"
import { AreasToReview } from "@/components/dependency/AreasToReview"
import { PreservationCard } from "@/components/dependency/PreservationCard"
import { NextSteps } from "@/components/dependency/NextSteps"

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

  let hasFindings = false
  try {
    const report = await getDependencyReport(address.toLowerCase())
    hasFindings = report.inventoryTotals.totalContracts > 0
  } catch {
    hasFindings = false
  }

  return {
    title: "Artist dependency report",
    description:
      "What PND can identify about the systems around an artist's work.",
    ...(!hasFindings && {
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

  if (!ADDRESS_RE.test(decoded)) {
    redirect(`/dependency/${address.toLowerCase()}`)
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      <header className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          Artist systems report
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Artist dependency report
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
    <div className="space-y-10">
      <div className="flex items-center gap-4">
        {identity.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
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

      <section className="space-y-3">
        <SectionHeader title="Inventory" />
        <InventoryTotals totals={report.inventoryTotals} />
        {report.platformCoverage.errors.length > 0 && (
          <p className="text-xs text-amber-700">
            PND couldn&rsquo;t reach{" "}
            {report.platformCoverage.errors
              .map((e) => systemLabel(e.platform))
              .join(", ")}{" "}
            in time. Tokens on those systems may be missing from this report.
          </p>
        )}
        {!report.indexerHealthy && (
          <p className="text-xs text-amber-700">
            PND&rsquo;s indexer was unavailable; Foundation contract data may
            be incomplete in this report.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Contract map"
          right={`${report.contractMap.length} ${report.contractMap.length === 1 ? "contract" : "contracts"}`}
        />
        <ContractMapTable artist={address} entries={report.contractMap} />
      </section>

      <section className="space-y-3">
        <SectionHeader title="Dependency read" />
        <DependencyReadCard read={report.dependencyRead} />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Areas to review"
          right={`${report.areasToReview.length} areas`}
        />
        <AreasToReview
          areas={report.areasToReview.filter((a) => a.id !== "preservation")}
        />
        {(() => {
          const presEntry = report.areasToReview.find(
            (a) => a.id === "preservation",
          )
          return presEntry ? (
            <PreservationCard
              entry={presEntry}
              preservation={report.preservation}
            />
          ) : null
        })()}
      </section>

      {report.recommendedNextSteps.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title="Recommended next steps" />
          <NextSteps steps={report.recommendedNextSteps} />
        </section>
      )}

      <div className="pt-4 border-t border-gray-100 space-y-1.5 text-xs text-gray-400">
        <p>
          PND only identifies what it can find in supported sources. Not found
          and Not yet do not mean absent everywhere.
        </p>
        <p>
          PND indexes Foundation and PND/Sovereign events from late 2025
          onward. Activity older than the indexer start block is not included
          in this report.
        </p>
      </div>
    </div>
  )
}

function SectionHeader({
  title,
  right,
}: {
  title: string
  right?: string
}) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-lg font-semibold">{title}</h2>
      {right && <span className="text-xs text-gray-500">{right}</span>}
    </div>
  )
}

function systemLabel(p: string): string {
  switch (p) {
    case "foundation":
      return "Foundation"
    case "manifold":
      return "Manifold"
    case "superrareV2":
      return "SuperRare"
    case "transient":
      return "Transient"
    case "sovereign":
      return "PND"
    default:
      return p
  }
}

function ScanFallback({ address }: { address: string }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Reviewing supported sources for{" "}
        <span className="font-mono">
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        ...
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="border border-gray-200 rounded-md px-4 py-3 h-[68px] animate-pulse"
          />
        ))}
      </div>
    </div>
  )
}
