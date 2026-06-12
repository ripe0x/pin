import type { Metadata } from "next"
import { redirect } from "next/navigation"
import Link from "next/link"
import type { Address } from "viem"
import { resolveEnsAddress } from "@/lib/artist-queries"
import { getCatalog } from "@/lib/catalog"
import {
  getImportSource,
  listImportSourcesForArtist,
} from "@/lib/import-sources"
import { normalize } from "@/lib/import-sources/normalize"
import type { ImportSource } from "@/lib/import-sources/types"
import { ImportPlanner } from "@/components/catalog/ImportPlanner"

/**
 * Batch import page. Resolves the artist address, picks an import
 * source (artist-specific adapters like Brinkman's bespoke registry, or
 * the generic `pnd-indexed` adapter that prefills from our own indexer),
 * normalizes against the on-chain Catalog, and hands the plan to
 * <ImportPlanner> for review + signing. Reachable at
 * `/artist/[address]/import?source=<id>`. Default source is the first
 * applicable in registry order — currently Brinkman's bespoke registry
 * when it matches, otherwise `pnd-indexed`.
 */

type Params = Promise<{ address: string }>
type SearchParams = Promise<{ source?: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

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
  if (!address) return { title: "Import to Catalog" }
  return {
    title: `Import to Catalog`,
    robots: { index: false, follow: false },
  }
}

export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { address: raw } = await params
  const { source: requestedSourceId } = await searchParams
  const decoded = decodeURIComponent(raw)
  const address = await resolveParam(raw)

  if (!address) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <h1 className="text-2xl font-semibold">Not Found</h1>
        <p className="text-gray-500 mt-2">
          Could not resolve &ldquo;{decoded}&rdquo; to an Ethereum address.
        </p>
      </div>
    )
  }
  if (!ADDRESS_RE.test(decoded)) {
    redirect(`/artist/${address}/import`)
  }

  const sources = listImportSourcesForArtist(address as Address)
  if (sources.length === 0) {
    // pnd-indexed is unconditional, so this should be unreachable in
    // practice — but keep the empty-state branch so the page can't
    // crash if the provider list is ever pruned.
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold">No import source available</h1>
        <p className="text-gray-500 mt-3">
          We don&rsquo;t have any import source configured for{" "}
          <span className="font-mono text-xs">{address}</span>.
        </p>
      </div>
    )
  }

  const source =
    (requestedSourceId
      ? sources.find((s) => s.id === requestedSourceId)
      : null) ??
    getImportSource(address as Address, sources[0].id)!

  let fetched: Awaited<ReturnType<typeof source.fetchWorks>> = {
    works: [],
    skipped: [],
  }
  let fetchError: string | null = null
  try {
    fetched = await source.fetchWorks()
  } catch (e) {
    fetchError =
      e instanceof Error ? e.message : "Failed to fetch the source registry."
  }

  const existing = await getCatalog(address as Address)
  const plan = normalize(fetched.works, existing, fetched.skipped)

  return (
    <div>
      {sources.length > 1 && (
        <SourcePicker
          sources={sources}
          currentId={source.id}
          artistAddress={address as Address}
        />
      )}
      <ImportPlanner
        artistAddress={address as Address}
        sourceName={source.displayName}
        sourceUrl={source.sourceUrl}
        plan={plan}
        fetchError={fetchError}
      />
    </div>
  )
}

function SourcePicker({
  sources,
  currentId,
  artistAddress,
}: {
  sources: ImportSource[]
  currentId: string
  artistAddress: Address
}) {
  return (
    <div className="mx-auto max-w-5xl px-6 pt-8">
      <p className="text-xs uppercase tracking-widest text-gray-500 mb-2">
        Source
      </p>
      <div className="inline-flex border border-gray-200 rounded-md overflow-hidden text-xs">
        {sources.map((s) => {
          const active = s.id === currentId
          return (
            <Link
              key={s.id}
              href={`/artist/${artistAddress}/import?source=${s.id}`}
              className={`px-3 py-2 transition-colors ${
                active
                  ? "bg-fg text-bg"
                  : "bg-surface text-gray-700 hover:bg-gray-100"
              }`}
            >
              {s.displayName}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
