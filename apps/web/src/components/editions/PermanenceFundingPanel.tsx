import { formatEther, type Address } from "viem"
import {
  EditionStatus,
  SURFACE_SHARE_BPS,
  evmNowAddressUrl,
  formatBps,
  shortAddress,
} from "@/lib/pnd-editions"
import { pinYearsLabel, pinYearsPerMint } from "@/lib/editions-durability"

// Rough, clearly-labeled assumptions for the ETH→"years of pinning" estimate.
// Pinata pay-to-pin ≈ $0.10/GB/mo = $1.20/GB/yr; a reference work size; a rough
// ETH price. Stated in the UI tooltip, not hidden. Same cost model the hot-pin
// card uses (pinYearsPerMint), so the two always agree.
const DEFAULT_ETH_USD = 3_000
const DEFAULT_ARTWORK_BYTES = 25_000_000 // ~25 MB reference work

/**
 * Public, mid-mint view of how an edition's mints fund its own permanence
 * (Phase 1 surface, docs/editions-permanence-funding.md). A `permanenceBps`
 * slice of every mint routes to the artist-owned vault; this panel makes that
 * visible to collectors: each mint sets aside a little more toward keeping the
 * work alive.
 *
 * RPC discipline: ZERO chain reads. The accrual is derived from `price`,
 * `minted`, and `bps` — all already read for the page — so this adds no calls.
 * The figure is an estimate of mint proceeds earmarked for permanence (labeled
 * "≈"); the exact withdrawable balance lives on-chain (vault link) and in the
 * artist's owner-only panel.
 */

function trimEth(wei: bigint): string {
  const s = formatEther(wei)
  if (!s.includes(".")) return s
  const trimmed = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
  // Cap to a readable precision.
  const [intPart, frac = ""] = trimmed.split(".")
  return frac ? `${intPart}.${frac.slice(0, 5)}` : intPart
}

export function PermanenceFundingPanel({
  vault,
  bps,
  price,
  minted,
  supplyCap,
  status,
  chainId,
  ethUsd = DEFAULT_ETH_USD,
  artworkBytes = DEFAULT_ARTWORK_BYTES,
}: {
  vault: Address
  bps: number
  price: bigint
  minted: bigint
  supplyCap: bigint
  status: EditionStatus
  chainId: number
  ethUsd?: number
  artworkBytes?: number
}) {
  // Proceeds earmarked for permanence so far ≈ minted × price × bps / 10000.
  const accrued = (minted * price * BigInt(bps)) / 10_000n
  const perMint = (price * BigInt(bps)) / 10_000n
  const live = status === EditionStatus.Open
  // Years of IPFS pinning the funds buy — same cost model as the hot-pin card,
  // surface netted out (clamped for display; assumptions in the tooltip).
  const yearsPerMint = pinYearsPerMint({
    priceWei: price,
    permanenceBps: bps,
    surfaceBps: SURFACE_SHARE_BPS,
    ethUsd,
    artworkBytes,
  })
  const pinYears = pinYearsLabel(Number(minted) * yearsPerMint)
  const capped = supplyCap > 0n
  const pct = capped && supplyCap > 0n ? Number((minted * 100n) / supplyCap) : 0

  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="mb-3 flex items-center gap-2 text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400">
        <span
          className={`h-1.5 w-1.5 rounded-full ${live ? "bg-status-available animate-pulse" : "bg-fg-subtle"}`}
          aria-hidden="true"
        />
        Storage funded by mints
        {live && <span className="text-status-available">· live</span>}
      </h2>

      <div className="rounded-lg border border-gray-200 bg-surface p-4 space-y-3">
        <p className="text-[11px] font-mono leading-relaxed text-fg-muted">
          <span className="text-fg">{formatBps(bps)}</span> of every mint is set
          aside to keep this work&rsquo;s media alive.
        </p>

        <div className="flex items-baseline justify-between">
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Set aside so far
          </span>
          <span className="text-lg font-mono font-medium tabular-nums">
            ≈ {trimEth(accrued)} <span className="text-xs text-gray-500">ETH</span>
          </span>
        </div>

        {pinYears !== "—" && (
          <p
            className="text-[10px] font-mono text-gray-500"
            title={`Estimate: IPFS pinning at ~$0.10/GB/mo for a ~${Math.round(artworkBytes / 1_000_000)} MB work, ETH ≈ $${ethUsd.toLocaleString()}, surface share netted out. A pay-once Arweave floor is separate and cheaper.`}
          >
            ≈ funds {pinYears} of IPFS pinning
          </p>
        )}

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <span>{capped ? `${minted.toString()} / ${supplyCap.toString()} minted` : `${minted.toString()} minted`}</span>
            <span className="normal-case tracking-normal text-gray-400">
              +{trimEth(perMint)} ETH / mint
            </span>
          </div>
          {capped && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-bg">
              <div
                className="h-full bg-fg/70"
                style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
              />
            </div>
          )}
        </div>

        <p className="text-[10px] font-mono leading-relaxed text-gray-500">
          Routes to the artist&rsquo;s permanence vault to fund a pay-once Arweave
          copy or renewable pinning. Not &ldquo;permanent&rdquo; until funded —
          the badge shows the honest status. PND never holds it.
        </p>

        <a
          href={evmNowAddressUrl(vault, chainId)}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
        >
          Vault {shortAddress(vault)} ↗
        </a>
      </div>
    </section>
  )
}
