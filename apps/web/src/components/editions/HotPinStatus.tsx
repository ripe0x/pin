import { fundedForLabel, formatFundedThrough } from "@/lib/editions-durability"

/**
 * Hot redundancy status: a renewable IPFS pin via Pinata (the Phase 5 rail of
 * docs/editions-permanence-funding.md), funded ahead by the accumulated mint
 * slice. Shows HOW MANY YEARS the pin is funded for and the Pinata IPFS path.
 *
 * Honest by construction: this is RENTED availability, not permanence — it
 * lapses when the funding runs out, so it shows a funded-for duration + a
 * lapse date, never "permanent". Presentational (pure props), so it renders in
 * the preview route and, once the hot rail lands, on the live edition page.
 */

const PINATA_GATEWAY = "https://gateway.pinata.cloud"

export function HotPinStatus({
  cid,
  fundedThrough,
  nowSec,
}: {
  cid: string
  fundedThrough: number
  nowSec: number
}) {
  const lapsed = fundedThrough <= nowSec
  const path = `ipfs://${cid}`
  const url = `${PINATA_GATEWAY}/ipfs/${cid}`

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-fg-subtle">
          <span
            className={`h-1.5 w-1.5 rounded-full ${lapsed ? "bg-red-500" : "bg-status-upcoming"}`}
            aria-hidden="true"
          />
          Pinned on IPFS · Pinata
        </span>
        <span className="text-sm font-mono font-medium tabular-nums">
          {lapsed ? "lapsed" : fundedForLabel(fundedThrough, nowSec)}
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-3 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        <span>{lapsed ? "Lapsed" : "Funded through"}</span>
        <span className="tabular-nums">{formatFundedThrough(fundedThrough)}</span>
      </div>

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block break-all font-mono text-[10px] text-fg-subtle underline hover:text-fg"
        title={url}
      >
        {path}
      </a>

      <p className="text-[10px] font-mono leading-relaxed text-gray-500">
        Rented availability, renewed from the work&rsquo;s permanence vault — not
        permanent on its own. The Arweave floor is the durable copy.
      </p>
    </div>
  )
}
