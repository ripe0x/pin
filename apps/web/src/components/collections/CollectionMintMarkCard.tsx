/**
 * Provenance display for a token's Mint Mark — fully DERIVED, matching the
 * onchain renderers: sequential token id IS the mint order; First/Final
 * derive from the id against the live minted count and status. Framed as
 * provenance, never as rarity: no rank, no score, no floor.
 */
import { SurfaceStatus } from "@/lib/collection"

export function CollectionMintMarkCard({
  mintOrder,
  seed,
  status,
  minted,
}: {
  /** Sequential: the token id (== mint order). Null for pooled ids. */
  mintOrder: number | null
  seed: `0x${string}` | null
  status: SurfaceStatus
  minted: bigint
}) {
  const isFirst = mintOrder === 1
  const isFinal =
    mintOrder !== null && status === SurfaceStatus.Closed && BigInt(mintOrder) === minted
  return (
    <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          Mint Mark
        </span>
        <span className="text-[10px] font-mono text-gray-400">· onchain provenance</span>
      </div>
      <dl className="divide-y divide-gray-100">
        {mintOrder !== null && (
          <Row label="Mint order" value={`#${mintOrder} in the collection`} />
        )}
        {seed && <Row label="Seed" value={`${seed.slice(0, 10)}…${seed.slice(-8)}`} />}
        {(isFirst || isFinal) && (
          <div className="px-4 py-3 flex flex-wrap gap-2">
            {isFirst && <Badge>First mint of the collection</Badge>}
            {isFinal && <Badge>Final mint of the collection</Badge>}
          </div>
        )}
      </dl>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-4 py-2.5 flex items-baseline justify-between gap-4">
      <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">{label}</dt>
      <dd className="text-[11px] font-mono tabular-nums text-right">{value}</dd>
    </div>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-gray-200 bg-surface-muted/40">
      {children}
    </span>
  )
}
