/**
 * Pure formatting helpers — usable from both server and client without
 * pulling in viem's tree-shake-unfriendly utilities at the call site.
 */
import { formatEther, type Address } from "viem"

export function formatEth(wei: string | bigint, decimals = 4): string {
  const n = typeof wei === "string" ? BigInt(wei) : wei
  const f = formatEther(n)
  // Trim trailing zeros while preserving up to `decimals` of significand.
  const [whole, frac = ""] = f.split(".")
  if (frac.length === 0) return `${whole}`
  const trimmed = frac.slice(0, decimals).replace(/0+$/, "")
  return trimmed ? `${whole}.${trimmed}` : `${whole}`
}

export function formatAddress(addr: Address | string): string {
  if (!addr) return ""
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Returns "2d 4h", "12m 30s" etc. */
export function formatTimeRemaining(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return "Ended"
  const d = Math.floor(secondsRemaining / 86400)
  const h = Math.floor((secondsRemaining % 86400) / 3600)
  const m = Math.floor((secondsRemaining % 3600) / 60)
  const s = secondsRemaining % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function formatRelativeTime(unixSec: number): string {
  if (unixSec === 0) return ""
  const diff = Math.floor(Date.now() / 1000) - unixSec
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return new Date(unixSec * 1000).toLocaleDateString()
}
