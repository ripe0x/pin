import {
  formatFundedThrough,
  perMintLabel,
  pinYearsLabel,
  pinYearsPerMint,
  type PinCostInput,
} from "@/lib/editions-durability"

/**
 * Hot redundancy status: a renewable IPFS pin via Pinata (the Phase 5 rail of
 * docs/editions-permanence-funding.md), funded ahead by the accumulated mint
 * slice. Everything here derives from the SAME cost model the funding panel uses
 * (pinYearsPerMint, surface netted out), so the mint↔year ratio is consistent
 * and real, not illustrative:
 *   yearsPerMint = (price × (1−surface) × slice × ethUSD) / (sizeGB × $/GB/yr)
 *   yearsFunded  = mints × yearsPerMint
 *
 * Honest: rented availability, never "permanent" — it shows a funded-for
 * duration + lapse date. Presentational (pure props).
 */

const PINATA_GATEWAY = "https://gateway.pinata.cloud"
const YEAR = 365 * 86_400
const HORIZON_YEARS = 10 // visual scale for open editions

export function HotPinStatus({
  cid,
  nowSec,
  mints,
  supplyCap,
  cost,
}: {
  cid: string
  nowSec: number
  /** Mints that have funded this pin. */
  mints: number
  /** Edition cap (0 = open edition). Drives the bar when capped. */
  supplyCap?: number
  /** The pinning cost inputs — the single source of truth for the ratio. */
  cost: PinCostInput
}) {
  const yearsPerMint = pinYearsPerMint(cost)
  const yearsFunded = mints * yearsPerMint
  const fundedThrough = Math.round(nowSec + yearsFunded * YEAR)
  const lapsed = yearsFunded <= 0

  const capped = !!supplyCap && supplyCap > 0
  const pct = lapsed
    ? 0
    : capped
      ? Math.min(100, Math.max(3, (mints / supplyCap) * 100))
      : Math.min(100, Math.max(3, (yearsFunded / HORIZON_YEARS) * 100))

  const path = `ipfs://${cid}`
  const url = `${PINATA_GATEWAY}/ipfs/${cid}`

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-fg-subtle">
          <span
            className={`h-1.5 w-1.5 rounded-full ${lapsed ? "bg-red-500" : "bg-status-upcoming"}`}
            aria-hidden="true"
          />
          Pinned on IPFS · Pinata
        </span>
        <span className="text-sm font-mono font-medium tabular-nums">
          {lapsed ? "not yet funded" : pinYearsLabel(yearsFunded)}
        </span>
      </div>

      {/* Runway bar: mints contributed (capped) or funded years (open). */}
      <div className="space-y-1.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-bg">
          <div
            className={`h-full ${lapsed ? "bg-red-500" : "bg-status-upcoming"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between gap-3 text-[10px] font-mono text-gray-500">
          <span>
            {capped ? `${mints} / ${supplyCap} mints` : `${mints} mint${mints === 1 ? "" : "s"}`} funded
          </span>
          {!lapsed && <span className="tabular-nums text-fg-subtle">{perMintLabel(yearsPerMint)}</span>}
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-3 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        <span>{lapsed ? "—" : "Pinned through"}</span>
        <span className="tabular-nums">{lapsed ? "—" : formatFundedThrough(fundedThrough)}</span>
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
    </div>
  )
}
