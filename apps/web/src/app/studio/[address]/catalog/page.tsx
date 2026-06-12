import { Suspense } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import type { Address } from "viem"
import { getCachedCatalog } from "@/lib/catalog-cache"
import { getContractThumbnails } from "@/lib/catalog-thumbs"
import { pndIndexedSource } from "@/lib/import-sources/pnd-indexed"
import { normalize } from "@/lib/import-sources/normalize"
import { RefreshButton } from "@/components/catalog/RefreshButton"
import { CatalogSummary } from "@/components/catalog/CatalogSummary"
import { AddEntrySection } from "@/components/catalog/AddEntrySection"
import { CatalogContractsEditable } from "@/components/catalog/CatalogContractsEditable"
import { CatalogTokensEditable } from "@/components/catalog/CatalogTokensEditable"
import { CatalogRangesEditable } from "@/components/catalog/CatalogRangesEditable"
import { CatalogOperatorEditable } from "@/components/catalog/CatalogOperatorEditable"
import { IndexedWorkSection } from "@/components/catalog/IndexedWorkSection"

/**
 * Catalog management — the editable view of the artist's onchain
 * record. The public read-only record stays at /catalog/[address];
 * this page carries everything that writes: the pre-fill planner,
 * manual add, per-row remove, the indexer refresh button, and
 * operator delegation.
 *
 * Same ISR + tag story as the public record: reads ride
 * `getCachedCatalog` (tag "catalog"), and every successful write fires
 * revalidateTag("catalog") via /api/catalog/[address]/revalidate, so
 * the hour-long timer is only a backstop.
 */
export const revalidate = 3600

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export default async function StudioCatalogPage({
  params,
}: {
  params: Params
}) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!ADDRESS_RE.test(address)) notFound()

  return (
    <Suspense fallback={<CatalogFallback />}>
      <CatalogManageBody address={address as Address} />
    </Suspense>
  )
}

async function CatalogManageBody({ address }: { address: Address }) {
  const record = await getCachedCatalog(address.toLowerCase())

  const contractAddressesForThumbs = Array.from(
    new Set([
      ...record.contracts,
      ...record.tokenRanges.map((r) => r.contractAddress),
    ]),
  )
  const thumbnails = await getContractThumbnails(contractAddressesForThumbs)

  // Pre-seed plan from PND's indexed work, computed server-side (the
  // import-sources module is server-only; this is why the studio is
  // address-scoped — the address in the URL keeps this a server
  // component).
  let indexedPlan: ReturnType<typeof normalize> | null = null
  let indexedPlanError: string | null = null
  try {
    const source = pndIndexedSource(address)
    const fetched = await source.fetchWorks()
    indexedPlan = normalize(
      fetched.works,
      {
        contracts: record.contracts.map((c) => c.toLowerCase() as Address),
        tokens: record.tokens.map((t) => ({
          contractAddress: t.contractAddress.toLowerCase() as Address,
          tokenId: t.tokenId,
        })),
        tokenRanges: record.tokenRanges.map((r) => ({
          contractAddress: r.contractAddress.toLowerCase() as Address,
          startTokenId: r.startTokenId,
          endTokenId: r.endTokenId,
        })),
      },
      fetched.skipped,
    )
  } catch (e) {
    indexedPlanError =
      e instanceof Error ? e.message : "Failed to load indexed work."
  }

  const empty =
    record.contracts.length === 0 &&
    record.tokens.length === 0 &&
    record.tokenRanges.length === 0

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold tracking-tight">Catalog</h2>
            <p className="text-sm text-gray-500 leading-relaxed">
              Your onchain record of contracts, tokens, and token ranges.
              Edits are transactions you sign; the{" "}
              <Link
                href={`/catalog/${address.toLowerCase()}`}
                className="underline underline-offset-4 hover:text-fg transition-colors"
              >
                public record
              </Link>{" "}
              updates as soon as they confirm.
            </p>
          </div>
          <RefreshButton artistAddress={address} />
        </div>
        {!empty && (
          <CatalogSummary
            contracts={record.contracts.length}
            tokens={record.tokens.length}
            ranges={record.tokenRanges.length}
          />
        )}
      </header>

      {empty && (
        <div className="border border-dashed border-gray-200 rounded-md p-6 text-sm text-gray-500">
          Your catalog is empty. Add entries below, or pre-fill from the
          work PND has already indexed.
        </div>
      )}

      {indexedPlan && (
        <IndexedWorkSection
          artist={address}
          plan={indexedPlan}
          fetchError={indexedPlanError}
        />
      )}

      <AddEntrySection
        artist={address}
        prefillPanelPresent={
          !!indexedPlan &&
          (indexedPlan.ops.length > 0 || indexedPlan.alreadyIndexed.length > 0)
        }
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

      {record.contracts.length > 0 && (
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
            thumbnails={thumbnails}
          />
        </section>
      )}

      {record.tokens.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Tokens"
            right={`${record.tokens.length} ${
              record.tokens.length === 1 ? "entry" : "entries"
            }`}
          />
          <CatalogTokensEditable artist={address} tokens={record.tokens} />
        </section>
      )}

      {record.tokenRanges.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Token ranges"
            right={`${record.tokenRanges.length} ${
              record.tokenRanges.length === 1 ? "entry" : "entries"
            }`}
          />
          <CatalogRangesEditable
            artist={address}
            ranges={record.tokenRanges}
            thumbnails={thumbnails}
          />
        </section>
      )}

      <CatalogOperatorEditable artist={address} />

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
      <h3 className="text-sm font-medium text-gray-700">{title}</h3>
      {right && (
        <span className="text-[11px] font-mono text-gray-500">{right}</span>
      )}
    </div>
  )
}

function CatalogFallback() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-6 w-32 rounded skeleton" />
        <div className="h-4 w-72 rounded skeleton" />
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="border border-gray-200 rounded-md px-3 py-2.5 flex items-center gap-3"
        >
          <div className="h-10 w-10 shrink-0 rounded-md skeleton" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-32 rounded skeleton" />
            <div className="h-3 w-56 rounded skeleton" />
          </div>
        </div>
      ))}
    </div>
  )
}
