/**
 * Provenance display for a token's Mint Mark. Framed as provenance, never as
 * rarity: no rank, no score, no floor. A stamp on the back of the print.
 */
import {
  type EditionMintMark,
  EDITION_STATUS_LABEL,
  evmNowAddressUrl,
  shortAddress,
  ZERO_ADDRESS,
} from "@/lib/pnd-editions"

export function MintMarkCard({ mark, chainId }: { mark: EditionMintMark; chainId: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          Mint Mark
        </span>
        <span className="text-[10px] font-mono text-gray-400">· onchain provenance</span>
      </div>
      <dl className="divide-y divide-gray-100">
        <Row label="Mint order" value={`#${mark.indexInEdition + 1} in the edition`} />
        <Row label="Mint block" value={mark.mintBlock.toString()} />
        <Row label="Status at mint" value={EDITION_STATUS_LABEL[mark.statusAtMint]} />
        <Row
          label="Mint surface"
          value={
            mark.surface === ZERO_ADDRESS ? (
              <span className="text-gray-400">none (direct)</span>
            ) : (
              <a
                href={evmNowAddressUrl(mark.surface, chainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-fg"
              >
                {shortAddress(mark.surface)} ↗
              </a>
            )
          }
        />
        {(mark.isFirst || mark.isFinal) && (
          <div className="px-4 py-3 flex flex-wrap gap-2">
            {mark.isFirst && <Badge>First mint of the edition</Badge>}
            {mark.isFinal && <Badge>Final mint of the edition</Badge>}
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
