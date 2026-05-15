import type { Metadata } from "next"
import { Suspense } from "react"
import { redirect } from "next/navigation"
import type { Address } from "viem"
import { after } from "next/server"
import { resolveEnsAddress, getArtistIdentity } from "@/lib/artist-queries"
import { getCachedCatalog } from "@/lib/catalog-cache"
import { maybeRefreshArtistIfStale } from "@/lib/external-indexer"

/**
 * Incremental Static Regeneration — the rendered HTML is cached at the
 * CDN per-URL on first hit and regenerated in the background at most
 * once every 60s. Most visitors hit a static response; the function
 * only fires on revalidation, and when it does the underlying read is
 * a handful of Postgres SELECTs (see `lib/catalog.ts`) instead of a
 * viem multicall against the chain. Combined cost in steady state is
 * ~nothing per visitor.
 *
 * The post-write `useCatalogWrite` flow still fires
 * `revalidateTag("catalog")` from `/api/catalog/[address]/revalidate`,
 * which evicts every ISR entry that touched `getCachedCatalog`.
 */
export const revalidate = 60
import { AddressZorb } from "@/components/AddressZorb"
import { CatalogSummary } from "@/components/catalog/CatalogSummary"
import { AddEntrySection } from "@/components/catalog/AddEntrySection"
import { CatalogContractsEditable } from "@/components/catalog/CatalogContractsEditable"
import { CatalogTokensEditable } from "@/components/catalog/CatalogTokensEditable"
import { CatalogRangesEditable } from "@/components/catalog/CatalogRangesEditable"
import { EditModeIndicator } from "@/components/catalog/EditModeIndicator"

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
  return {
    title: "Artist catalog",
    description: "On-chain catalog of contracts, tokens, and token ranges.",
  }
}

export default async function RecordPage({
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
          href="/catalog"
          className="inline-block mt-6 text-sm border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
        >
          Start over
        </a>
      </div>
    )
  }

  if (!ADDRESS_RE.test(decoded)) {
    redirect(`/catalog/${address.toLowerCase()}`)
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      <header className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          Artist catalog
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Artist catalog
        </h1>
      </header>

      <Suspense fallback={<RecordFallback />}>
        <RecordBody address={address as Address} />
      </Suspense>
    </div>
  )
}

async function RecordBody({ address }: { address: Address }) {
  // Register an after() callback synchronously during render so Netlify's
  // serverless runtime keeps the function alive past the response. The
  // previous `void maybeRefreshArtistIfStale()` pattern lost its
  // in-flight awaits to function teardown. No-op inside for unknown
  // addresses (gate) and within the 1h stale window. See
  // `lib/external-indexer.ts` header for the cost model.
  after(() => maybeRefreshArtistIfStale(address))

  const [identity, record] = await Promise.all([
    getArtistIdentity(address),
    getCachedCatalog(address.toLowerCase()),
  ])
  const empty =
    record.contracts.length === 0 &&
    record.tokens.length === 0 &&
    record.tokenRanges.length === 0

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
          <AddressZorb address={address} className="h-14 w-14 rounded-full" />
        )}
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-lg font-semibold truncate">
              {identity.displayName}
            </div>
            <EditModeIndicator artist={address} />
          </div>
          <div className="font-mono text-xs text-gray-400">
            {address.slice(0, 6)}...{address.slice(-4)}
          </div>
        </div>
      </div>

      {empty ? (
        <div className="border border-dashed border-gray-200 rounded-md p-6 text-sm text-gray-500">
          This catalog is empty. The artist controls what appears here.
        </div>
      ) : (
        <CatalogSummary
          contracts={record.contracts.length}
          tokens={record.tokens.length}
          ranges={record.tokenRanges.length}
        />
      )}

      <AddEntrySection
        artist={address}
        existing={{
          contracts: record.contracts.map((c) => c.toLowerCase()),
          tokens: record.tokens.map((t) => ({
            contractAddress: t.contractAddress.toLowerCase(),
            tokenId: t.tokenId,
          })),
          tokenRanges: record.tokenRanges.map((r) => ({
            contractAddress: r.contractAddress.toLowerCase(),
            startTokenId: r.startTokenId,
            endTokenId: r.endTokenId,
          })),
        }}
      />

      <section className="space-y-3">
        <SectionHeader
          title="Contracts"
          right={`${record.contracts.length} ${
            record.contracts.length === 1 ? "entry" : "entries"
          }`}
        />
        <CatalogContractsEditable
          artist={address}
          contracts={record.contracts}
        />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Tokens"
          right={`${record.tokens.length} ${
            record.tokens.length === 1 ? "entry" : "entries"
          }`}
        />
        <CatalogTokensEditable artist={address} tokens={record.tokens} />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Token ranges"
          right={`${record.tokenRanges.length} ${
            record.tokenRanges.length === 1 ? "entry" : "entries"
          }`}
        />
        <CatalogRangesEditable artist={address} ranges={record.tokenRanges} />
      </section>

      <p className="text-xs text-gray-400 pt-4 border-t border-gray-100">
        Adding a pointer means this address added it to its public
        catalog. It does not prove authorship, ownership, or endorsement.
      </p>
    </div>
  )
}

function SectionHeader({ title, right }: { title: string; right?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-lg font-semibold">{title}</h2>
      {right && <span className="text-xs text-gray-500">{right}</span>}
    </div>
  )
}

function RecordFallback() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">Loading catalog...</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="border border-gray-200 rounded-md px-4 py-3 h-[68px] animate-pulse"
          />
        ))}
      </div>
    </div>
  )
}
