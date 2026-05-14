import Link from "next/link"
import type { Address } from "viem"
import { getCachedArtistRecord } from "@/lib/artist-record-cache"
import { RecordContractsSection } from "@/components/record/RecordContractsSection"
import { RecordTokensSection } from "@/components/record/RecordTokensSection"
import { RecordRangesSection } from "@/components/record/RecordRangesSection"

/**
 * Renders the artist's on-chain record (from ArtistRecordRegistry) as a
 * compact subsection on `/artist/[address]`. Reads through the same
 * `getCachedArtistRecord` cache the `/record/[address]` page uses, so a
 * record-page visit and an artist-page visit share one cache entry.
 *
 * Returns `null` when the record is empty so cold artists don't see an
 * empty section. The artist's own management view lives at
 * `/record/[address]`; the link below the lists routes there.
 */
export async function ArtistRecordSection({
  address,
}: {
  address: Address
}) {
  const record = await getCachedArtistRecord(address.toLowerCase())
  const empty =
    record.contracts.length === 0 &&
    record.tokens.length === 0 &&
    record.tokenRanges.length === 0
  if (empty) return null

  return (
    <section className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Artist record</h2>
        <Link
          href={`/record/${address.toLowerCase()}`}
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
          <RecordContractsSection contracts={record.contracts} />
        </div>
      )}

      {record.tokens.length > 0 && (
        <div className="space-y-2">
          <SubHeader
            title="Tokens"
            count={record.tokens.length}
          />
          <RecordTokensSection tokens={record.tokens} />
        </div>
      )}

      {record.tokenRanges.length > 0 && (
        <div className="space-y-2">
          <SubHeader
            title="Token ranges"
            count={record.tokenRanges.length}
          />
          <RecordRangesSection ranges={record.tokenRanges} />
        </div>
      )}

      <p className="text-xs text-gray-400">
        Declared by the artist on the public ArtistRecordRegistry. Inclusion
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
