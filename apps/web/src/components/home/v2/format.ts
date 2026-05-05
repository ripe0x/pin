import { formatEther } from "viem"

/** Strip trailing zeros after the decimal point: 0.190 → 0.19, 2.00 → 2.
 * Leaves integers and zero-decimal numbers alone. */
function stripTrailingZeros(s: string): string {
  if (!s.includes(".")) return s
  return s.replace(/\.?0+$/, "")
}

export function formatEth(wei: bigint): string {
  const eth = Number(formatEther(wei))
  if (eth >= 100) return `${Math.round(eth)} Ξ`
  if (eth >= 1) return `${stripTrailingZeros(eth.toFixed(2))} Ξ`
  if (eth >= 0.01) return `${stripTrailingZeros(eth.toFixed(3))} Ξ`
  return `${stripTrailingZeros(eth.toFixed(4))} Ξ`
}

export function formatTimeAgo(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec)
  if (diff < 60) return `${diff}s`
  if (diff < 60 * 60) return `${Math.floor(diff / 60)}m`
  if (diff < 60 * 60 * 24) return `${Math.floor(diff / 3600)}h`
  if (diff < 60 * 60 * 24 * 30) return `${Math.floor(diff / 86400)}d`
  if (diff < 60 * 60 * 24 * 365) return `${Math.floor(diff / (86400 * 30))}mo`
  return `${Math.floor(diff / (86400 * 365))}y`
}

export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
