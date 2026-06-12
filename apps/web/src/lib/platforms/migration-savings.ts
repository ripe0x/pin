/**
 * Per-platform marketplace-fee constants used by the migrate panel to show
 * artists the savings they'd lock in by moving a listing onto a Sovereign
 * auction house (which charges 0 bps protocol fee — see
 * `SOVEREIGN_AUCTION_HOUSE_FACTORY` deploy notes in `@pin/addresses`).
 *
 * The bps values mirror the breakdowns surfaced in `AuctionPanel.tsx`'s
 * fees table — keep in sync if those change. SuperRare numbers reflect
 * the bid-distribution split at settlement, NOT the 3% buyer's premium
 * (the premium is paid by the bidder, not the seller, so it doesn't
 * affect seller savings).
 *
 * Foundation: the v2 NFTMarket charged a 500 (5%) protocol fee for years,
 * but Foundation has since removed the seller-side protocol fee — it's now
 * 0. With both source and destination at 0%, there's no fee delta to show,
 * so the migrate row suppresses the "you receive" comparison for any 0-fee
 * source (see `MigrateRow`) and just shows the relisting terms.
 *
 * SuperRare: the fee bps depends on primary vs secondary, which we don't
 * cheaply know per row in the cancellable-listings stream. We surface
 * the worst-case (15% — the primary-sale DAO Treasury cut) with a
 * "up to" qualifier so the artist sees the largest possible savings
 * up-front; the secondary case (10% creator royalty) is still a real
 * savings that lands when they actually relist.
 */

import { formatEther } from "viem"
import type { PlatformId } from "./types"

const FEE_BPS_BY_PLATFORM: Partial<Record<PlatformId, number>> = {
  foundation: 0, // Foundation removed the seller-side protocol fee
  superrareV2: 1500, // up to 15% (primary sale DAO Treasury cut)
}

const PLATFORM_LABELS: Partial<Record<PlatformId, string>> = {
  foundation: "Foundation",
  superrareV2: "SuperRare",
}

export type MigrationSavings = {
  /** Source-platform fee in basis points (10000 = 100%). */
  feeBps: number
  /** Display percent string, e.g. "5%" or "up to 15%". */
  pctLabel: string
  /** Source platform display name (e.g. "Foundation", "SuperRare"). */
  platformLabel: string
  /**
   * Estimated ETH saved at the user's current reserve price. The actual
   * savings at settle depend on the winning bid; this is a useful
   * lower-bound "if it sells at reserve" number.
   */
  savedAtReserveEth: string
}

/**
 * Compute fee-saved hint for a row in the migrate panel.
 *
 * `exactFeeBps` (optional) lets the caller pass a per-token bps the
 * adapter resolved precisely on-chain — currently SR V2 reads
 * `tokenCreator(tokenId)` to pick 1500 (primary) vs 1000 (secondary).
 * When omitted we fall back to the platform default (the adapter either
 * couldn't determine, or the platform has a flat fee), and the label
 * gets a "up to" qualifier on platforms whose default is itself an
 * upper bound (SR V2 — primary case).
 *
 * Returns `null` when the platform has no documented fee model (Manifold,
 * Sovereign — the latter is the destination, not a source).
 */
export function migrationSavings(
  platform: PlatformId,
  reserveWei: bigint,
  exactFeeBps?: number,
): MigrationSavings | null {
  const platformLabel = PLATFORM_LABELS[platform]
  if (!platformLabel) return null
  const fallbackBps = FEE_BPS_BY_PLATFORM[platform]
  const feeBps = exactFeeBps ?? fallbackBps
  if (feeBps === undefined) return null
  if (reserveWei < 0n) return null

  const savedWei = (reserveWei * BigInt(feeBps)) / 10_000n
  const savedAtReserveEth = formatEther(savedWei)

  const pct = (feeBps / 100).toFixed(0) + "%"
  // Only qualify with "up to" when we don't have a precise per-row bps
  // AND the platform's default could vary (SR V2 split between primary
  // and secondary). Foundation has a flat protocol fee, no qualifier.
  const isImprecise = exactFeeBps === undefined && platform === "superrareV2"
  const pctLabel = isImprecise ? `up to ${pct}` : pct

  return { feeBps, pctLabel, platformLabel, savedAtReserveEth }
}

/**
 * Trim trailing zeros from a formatEther string for display, capping
 * at 4 decimals so the row stays narrow. "0.025000000000000000" → "0.025".
 */
export function compactEth(s: string): string {
  if (!s.includes(".")) return s
  const [whole, frac] = s.split(".")
  const trimmed = frac.replace(/0+$/, "").slice(0, 4)
  if (trimmed.length === 0) return whole
  return `${whole}.${trimmed}`
}

/**
 * Hard-coded ETH/USD reference for the migrate panel. The number isn't
 * critical to settlement — it's a "if it sells at reserve, you'd net
 * roughly $X" hint to make the side-by-side comparison feel concrete.
 * Real wiring (price feed via Coingecko or Chainlink) is a separate
 * concern; bumping this constant is a one-line dev override until then.
 */
const ETH_USD_REFERENCE = 3200

function formatUsd(n: number): string {
  if (Number.isNaN(n) || !Number.isFinite(n)) return "—"
  if (n >= 100) {
    return n.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })
  }
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  })
}

/**
 * Apply a basis-points fee to a string ETH amount and return the net
 * received as `{ eth, usd }` strings. Used by the migrate row to render
 * the "you receive" side-by-side comparison without color accents — the
 * numerical delta itself does the highlighting.
 *
 * Math is in floating point for ergonomics; precision lost on small
 * reserves (<0.001 ETH × 5%) is fine for a display-only hint. Settle-
 * time amounts come from the contract.
 */
export function netReceived(reserveEth: string, feeBps: number) {
  const n = parseFloat(reserveEth)
  if (Number.isNaN(n) || !Number.isFinite(n)) return { eth: "—", usd: "—" }
  const net = n * (1 - feeBps / 10_000)
  const ethStr = (() => {
    const s = net.toFixed(4)
    return s.replace(/0+$/, "").replace(/\.$/, "")
  })()
  return { eth: ethStr, usd: formatUsd(net * ETH_USD_REFERENCE) }
}
