import { formatEther } from "viem"

/**
 * Shared ETH + relative-time formatters. Lifted out of
 * `components/auction/SettledAuctionSummary.tsx` so the settled-auction card,
 * the per-auction page, and the Provenance "Sold" entry render amounts and
 * timestamps identically instead of each keeping a private copy.
 *
 * Server-safe (pure, no "use client") — importable from server components.
 */

/**
 * Drop trailing zeros so 0.190 → 0.19 while preserving all 18 decimals'
 * worth of precision a viewer might need to verify the on-chain value.
 */
export function formatEthAmount(wei: bigint): string {
  const s = formatEther(wei)
  if (!s.includes(".")) return s
  return s.replace(/0+$/, "").replace(/\.$/, "")
}

/** "3m ago" / "2h ago" / "5d ago" … Empty string for a 0 timestamp. */
export function formatRelativeTime(unixSec: number): string {
  if (unixSec === 0) return ""
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSec)
  if (diffSec < 60) return `${diffSec}s ago`
  const m = Math.floor(diffSec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}
