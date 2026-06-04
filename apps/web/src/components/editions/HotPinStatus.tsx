import { fundedForLabel, formatFundedThrough } from "@/lib/editions-durability"

/**
 * Hot redundancy status: a renewable IPFS pin via Pinata (the Phase 5 rail of
 * docs/editions-permanence-funding.md), funded ahead by the accumulated mint
 * slice. Shows HOW MANY YEARS the pin is funded for, a runway bar, the mints
 * that funded it (the value prop: minting buys pinning), and the Pinata path.
 *
 * Honest by construction: this is RENTED availability, not permanence — it
 * lapses when the funding runs out, so it shows a funded-for duration + a
 * lapse date, never "permanent". Presentational (pure props), so it renders in
 * the preview route and, once the hot rail lands, on the live edition page.
 */

const PINATA_GATEWAY = "https://gateway.pinata.cloud"
const YEAR = 365 * 86_400
// Visual scale for the runway bar: a full bar reads as "a decade funded".
const HORIZON_YEARS = 10

export function HotPinStatus({
  cid,
  fundedThrough,
  nowSec,
  mints,
}: {
  cid: string
  fundedThrough: number
  nowSec: number
  /** How many mints have funded this pin (the value-prop caption). */
  mints?: number
}) {
  const lapsed = fundedThrough <= nowSec
  const years = Math.max(0, (fundedThrough - nowSec) / YEAR)
  const pct = lapsed ? 0 : Math.min(100, Math.max(3, (years / HORIZON_YEARS) * 100))
  const perMintDays = mints && mints > 0 ? Math.round((years * 365) / mints) : null
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
          {lapsed ? "lapsed" : fundedForLabel(fundedThrough, nowSec)}
        </span>
      </div>

      {/* Runway bar: how far the pin is funded, on a ~decade scale. */}
      <div className="space-y-1.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-bg">
          <div
            className={`h-full ${lapsed ? "bg-red-500" : "bg-status-upcoming"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between gap-3 text-[10px] font-mono text-gray-500">
          <span>
            {mints != null
              ? `${mints} mint${mints === 1 ? "" : "s"} funded this pin`
              : "funded by mints"}
          </span>
          {perMintDays != null && !lapsed && (
            <span className="tabular-nums text-fg-subtle">≈ +{perMintDays}d / mint</span>
          )}
        </div>
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
