import Link from "next/link"
import type { ProfileCatalogEvidence } from "@/lib/profile-queries"
import { SectionHeading } from "./ProfileAvailable"

export function ProfileCatalog({
  address,
  catalog,
}: {
  address: string
  catalog: ProfileCatalogEvidence
}) {
  const total = catalog.contracts.length + catalog.tokens.length + catalog.ranges.length
  if (total === 0) return null
  return (
    <section id="catalog" className="scroll-mt-20 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <SectionHeading
          title="Catalog declarations"
          detail="Pointers this address declared in the public Catalog. Declaration is artist-authored context, not PND verification, current ownership, or curation."
        />
        <Link href={`/catalog/${address}`} className="shrink-0 text-xs text-gray-500 hover:text-fg">
          Full record →
        </Link>
      </div>
      <div className="space-y-3 font-mono text-[11px]">
        {catalog.contracts.map((entry) => (
          <a
            key={`contract:${entry.contract}`}
            href={`https://evm.now/address/${entry.contract}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex justify-between gap-3 border-b border-gray-100 pb-2 hover:text-gray-500"
          >
            <span>{short(entry.contract)}</span><span>declared contract ↗</span>
          </a>
        ))}
        {catalog.tokens.map((entry) => entry.indexed ? (
          <Link
            key={`token:${entry.contract}:${entry.tokenId}`}
            href={`/${entry.contract}/${entry.tokenId}`}
            className="flex justify-between gap-3 border-b border-gray-100 pb-2 hover:text-gray-500"
          >
            <span>{short(entry.contract)} / {entry.tokenId}</span>
            <span>declared · indexed</span>
          </Link>
        ) : (
          <div
            key={`token:${entry.contract}:${entry.tokenId}`}
            className="flex justify-between gap-3 border-b border-gray-100 pb-2 text-gray-500"
          >
            <span>{short(entry.contract)} / {entry.tokenId}</span>
            <span>declared · not in PND work index</span>
          </div>
        ))}
        {catalog.ranges.map((entry) => (
          <div key={`range:${entry.contract}:${entry.startTokenId}:${entry.endTokenId}`} className="flex justify-between gap-3 border-b border-gray-100 pb-2">
            <span>{short(entry.contract)} / {entry.startTokenId}–{entry.endTokenId}</span>
            <span>declared range</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
