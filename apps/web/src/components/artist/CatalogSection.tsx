import Link from "next/link"
import type { Address } from "viem"
import { getCachedCatalog } from "@/lib/catalog-cache"
import { CatalogContractsSection } from "@/components/catalog/CatalogContractsSection"
import { CatalogTokensSection } from "@/components/catalog/CatalogTokensSection"
import { CatalogRangesSection } from "@/components/catalog/CatalogRangesSection"

/**
 * Renders the artist's on-chain record (from Catalog) as a
 * compact subsection on `/artist/[address]`. Reads through the same
 * `getCachedCatalog` cache the `/record/[address]` page uses, so a
 * record-page visit and an artist-page visit share one cache entry.
 *
 * Returns `null` when the record is empty so cold artists don't see an
 * empty section. The artist's own management view lives at
 * `/record/[address]`; the link below the lists routes there.
 */
export async function CatalogSection({
  address,
}: {
  address: Address
}) {
  const record = await getCachedCatalog(address.toLowerCase())
  const empty =
    record.contracts.length === 0 &&
    record.tokens.length === 0 &&
    record.tokenRanges.length === 0
  if (empty) return null

  return (
    <section className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Artist catalog</h2>
        <Link
          href={`/catalog/${address.toLowerCase()}`}
          className="text-xs text-gray-500 hover:text-gray-900 underline-offset-2 hover:underline"
        >
          Manage →
        </Link>
      </div>

      {record.contracts.length > 0 && (
        <div className="space-y-2">
          <SubHeader
            title="Contracts"
            count={record.contracts.length}
          />
          <CatalogContractsSection contracts={record.contracts} />
        </div>
      )}

      {record.tokens.length > 0 && (
        <div className="space-y-2">
          <SubHeader
            title="Tokens"
            count={record.tokens.length}
          />
          <CatalogTokensSection tokens={record.tokens} />
        </div>
      )}

      {record.tokenRanges.length > 0 && (
        <div className="space-y-2">
          <SubHeader
            title="Token ranges"
            count={record.tokenRanges.length}
          />
          <CatalogRangesSection ranges={record.tokenRanges} />
        </div>
      )}

      <p className="text-xs text-gray-400">
        Declared by the artist on the public Catalog. Inclusion
        here means this address added the pointer; it is not a proof of
        authorship or ownership.
      </p>
    </section>
  )
}

function SubHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <h3 className="text-sm font-medium text-gray-700">{title}</h3>
      <span className="text-xs text-gray-500">
        {count} {count === 1 ? "entry" : "entries"}
      </span>
    </div>
  )
}
