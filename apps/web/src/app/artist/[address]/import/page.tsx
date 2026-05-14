import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import type { Address } from "viem"
import { resolveEnsAddress } from "@/lib/artist-queries"
import { getCatalog } from "@/lib/catalog"
import { getImportSource } from "@/lib/import-sources"
import { normalize } from "@/lib/import-sources/normalize"
import { ImportPlanner } from "@/components/catalog/ImportPlanner"

/**
 * Batch import page. Pulls an artist's externally-published registry
 * (per `IMPORT_SOURCES`), normalizes it against their on-chain Catalog,
 * and hands the plan to <ImportPlanner> for review + signing. Reachable
 * at `/artist/[address]/import`; falls through to 404 for any address
 * that doesn't have a registered import source.
 */

type Params = Promise<{ address: string }>

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
  const source = getImportSource(address)
  const name = source?.displayName ?? address
  return {
    title: `Import ${name}'s registry to Catalog`,
    robots: { index: false, follow: false },
  }
}

export default async function ImportPage({ params }: { params: Params }) {
  const { address: raw } = await params
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

  const source = getImportSource(address)
  if (!source) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold">No import source registered</h1>
        <p className="text-gray-500 mt-3">
          We don&rsquo;t have a registered external registry for{" "}
          <span className="font-mono text-xs">{address}</span> yet.
        </p>
        <p className="text-gray-500 mt-2">
          If this artist publishes a machine-readable registry, get in touch
          and we can add it.
        </p>
      </div>
    )
  }

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
    <ImportPlanner
      artistAddress={address as Address}
      sourceName={source.displayName}
      sourceUrl={source.sourceUrl}
      plan={plan}
      fetchError={fetchError}
    />
  )
}
