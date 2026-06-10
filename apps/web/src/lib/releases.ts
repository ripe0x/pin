import { type Address } from "viem"
import { RELEASE_FACTORY, getAddressOrNull } from "@pin/addresses"
import { formatEthAmount } from "@/lib/format-eth"

/**
 * Client-safe helpers for the Releases protocol (open editions).
 *
 * Deliberately self-contained: no imports from the editions module (which
 * is scheduled for removal before Releases ships) — the few tiny generic
 * helpers are duplicated here on purpose.
 *
 * The protocol in three sentences, which the UI must never contradict:
 *   1. Free means gas only.
 *   2. The artist gets everything they priced.
 *   3. The surface earns only when chosen.
 */

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
export const RELEASES_CHAIN_ID = FORK_MODE ? 31339 : 1
/** Explorer links always use mainnet ids (the fork mirrors mainnet). */
export const RELEASES_EXPLORER_CHAIN_ID = 1

/** The deployed ReleaseFactory, or null when not configured for the env. */
export function releaseFactoryAddress(): Address | null {
  const env = process.env.NEXT_PUBLIC_RELEASE_FACTORY
  if (env && env.startsWith("0x") && env.length === 42) return env as Address
  return getAddressOrNull(RELEASE_FACTORY, 1)
}

/**
 * The surface address this deployment passes when serving mints. PND's
 * frontend sets NEXT_PUBLIC_PND_SURFACE_ADDRESS to PND's treasury; a
 * self-hosted page sets its own. Zero means "serve without a fee".
 */
export function releasesSurfaceAddress(): Address {
  const env = process.env.NEXT_PUBLIC_PND_SURFACE_ADDRESS
  if (env && env.startsWith("0x") && env.length === 42) return env as Address
  return ZERO_ADDRESS
}

// ── Enums (must match contracts/src/releases/IRelease.sol) ───────────────

export enum GateMode {
  None = 0,
  Hold = 1,
  Burn = 2,
}

export const GATE_MODE_LABELS: Record<GateMode, string> = {
  [GateMode.None]: "Open mint",
  [GateMode.Hold]: "Hold to mint",
  [GateMode.Burn]: "Burn to mint",
}

export enum ReleaseStatus {
  Scheduled = 0,
  Live = 1,
  SoldOut = 2,
  Closed = 3,
  Ended = 4,
}

export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  [ReleaseStatus.Scheduled]: "Scheduled",
  [ReleaseStatus.Live]: "Live",
  [ReleaseStatus.SoldOut]: "Sold out",
  [ReleaseStatus.Closed]: "Closed",
  [ReleaseStatus.Ended]: "Ended",
}

// ── Types (bigints as strings so they survive JSON caching) ──────────────

/** What the mint CTA needs to render and price a mint. */
export type ReleaseSnapshot = {
  price: string
  surfaceFee: string
  startTime: string
  endTime: string
  maxSupply: string
  totalMinted: string
  closed: boolean
  gateToken: Address
  gateMode: GateMode
}

/** Full release view for pages. */
export type ReleaseView = {
  address: Address
  name: string
  symbol: string
  artist: Address
  owner: Address
  payout: Address
  price: string
  surfaceFee: string
  startTime: string
  endTime: string
  maxSupply: string
  gateToken: Address
  gateMode: GateMode
  status: ReleaseStatus
  totalMinted: string
  totalSupply: string
  closed: boolean
  metadataFrozen: boolean
  uri: string
  uriPerToken: boolean
  renderer: Address
  royaltyReceiver: Address
  royaltyBps: number
  artistBalance: string
}

export function toSnapshot(r: ReleaseView): ReleaseSnapshot {
  return {
    price: r.price,
    surfaceFee: r.surfaceFee,
    startTime: r.startTime,
    endTime: r.endTime,
    maxSupply: r.maxSupply,
    totalMinted: r.totalMinted,
    closed: r.closed,
    gateToken: r.gateToken,
    gateMode: r.gateMode,
  }
}

// ── Pricing (mirrors Release._surfaceFeeFor exactly) ─────────────────────

/** Fee leg of a mint: zero when the release is free or no surface named. */
export function surfaceFeeFor(
  priceWei: bigint,
  feeWei: bigint,
  quantity: bigint,
  surface: Address,
): bigint {
  if (priceWei === 0n || surface === ZERO_ADDRESS) return 0n
  return feeWei * quantity
}

/** Exact msg.value a mint requires (the contract takes nothing else). */
export function mintCost(
  priceWei: bigint,
  feeWei: bigint,
  quantity: bigint,
  surface: Address,
): bigint {
  return (
    priceWei * quantity + surfaceFeeFor(priceWei, feeWei, quantity, surface)
  )
}

export function isGasOnly(priceWei: bigint): boolean {
  return priceWei === 0n
}

export function formatPriceLabel(priceWei: bigint): string {
  return priceWei === 0n
    ? "Free (gas only)"
    : `${formatEthAmount(priceWei)} ETH`
}

// ── Lifecycle (mirrors Release.status precedence exactly) ────────────────

export function liveStatus(s: ReleaseSnapshot, nowSec: number): ReleaseStatus {
  const maxSupply = BigInt(s.maxSupply)
  if (s.closed) return ReleaseStatus.Closed
  if (maxSupply !== 0n && BigInt(s.totalMinted) >= maxSupply) {
    return ReleaseStatus.SoldOut
  }
  if (nowSec < Number(s.startTime)) return ReleaseStatus.Scheduled
  const end = Number(s.endTime)
  if (end !== 0 && nowSec >= end) return ReleaseStatus.Ended
  return ReleaseStatus.Live
}

export function isMintable(s: ReleaseSnapshot, nowSec: number): boolean {
  return liveStatus(s, nowSec) === ReleaseStatus.Live
}

// ── Generic display helpers ──────────────────────────────────────────────

export function ipfsToHttp(uri: string): string {
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`
  }
  return uri
}

export function shortAddress(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function evmNowAddressUrl(
  addr: string,
  chainId: number = RELEASES_EXPLORER_CHAIN_ID,
): string {
  return `https://evm.now/address/${addr}?chainId=${chainId}`
}

export function evmNowTokenUrl(
  contract: string,
  chainId: number = RELEASES_EXPLORER_CHAIN_ID,
): string {
  return `https://evm.now/token/${contract}?chainId=${chainId}`
}
