import type { Address } from "viem"
import { IdMode, SurfaceStatus, type ReleaseState, type SaleWindow } from "./types.ts"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
export const REFERRAL_SHARE_BPS = 1000

export function isGasOnly(price: bigint): boolean {
  return price === 0n
}

export function hasPriceStrategy(priceStrategy: Address): boolean {
  return priceStrategy.toLowerCase() !== ZERO_ADDRESS
}

export function lifecycleStatus(window: SaleWindow, minted: bigint, nowSec: number): SurfaceStatus {
  const now = BigInt(Math.max(0, nowSec))
  if (window.mintStart !== 0n && now < window.mintStart) return SurfaceStatus.Scheduled
  if (window.mintEnd !== 0n && now >= window.mintEnd) return SurfaceStatus.Closed
  if (window.supplyCap !== 0n && minted >= window.supplyCap) return SurfaceStatus.Closed
  return SurfaceStatus.Open
}

export function isMintable(window: SaleWindow, minted: bigint, nowSec: number): boolean {
  return lifecycleStatus(window, minted, nowSec) === SurfaceStatus.Open
}

export type ReleaseAvailabilityOptions = {
  quantity?: bigint
  /** Whether the caller has a valid proof for a gated release. */
  allowlistProofAvailable?: boolean
}

export type ReleaseAvailability = {
  effectiveCap: bigint
  collectionRemaining: bigint | null
  saleRemaining: bigint | null
  remaining: bigint | null
  walletRemaining: bigint | null
  walletCapped: boolean
  allowlistRequired: boolean
  allowlistSatisfied: boolean
  quantityValid: boolean
  lifecycle: SurfaceStatus
  soldOut: boolean
  mintable: boolean
}

/**
 * Derives the complete availability boundary from one live provider state.
 * A zero cap means unlimited, and token/minter caps are independent ceilings.
 * Gated releases fail closed unless the caller explicitly supplies a proof.
 */
export function releaseAvailability(
  state: Pick<ReleaseState, "supplyCap" | "saleSupplyCap" | "saleMinted" | "minted" | "mintStart" | "mintEnd" | "allowlistRoot" | "walletCap" | "mintedByAccount">,
  nowSec: number,
  options: ReleaseAvailabilityOptions = {},
): ReleaseAvailability {
  const quantity = options.quantity ?? 1n
  const supplyCap = state.supplyCap
  const saleSupplyCap = state.saleSupplyCap ?? 0n
  const minted = state.minted
  const saleMinted = state.saleMinted ?? 0n
  const collectionRemaining = supplyCap > 0n ? supplyCap - minted : null
  const saleRemaining = saleSupplyCap > 0n ? saleSupplyCap - saleMinted : null
  const effectiveCap =
    supplyCap > 0n && saleSupplyCap > 0n
      ? supplyCap < saleSupplyCap ? supplyCap : saleSupplyCap
      : supplyCap > 0n ? supplyCap : saleSupplyCap
  const remaining = collectionRemaining === null
    ? saleRemaining
    : saleRemaining === null
      ? collectionRemaining
      : collectionRemaining < saleRemaining ? collectionRemaining : saleRemaining
  const walletCap = state.walletCap ?? 0n
  const mintedByAccount = state.mintedByAccount ?? 0n
  const walletRemaining = walletCap > 0n ? walletCap - mintedByAccount : null
  const walletCapped = walletRemaining !== null && walletRemaining <= 0n
  const zeroRoot = "0x" + "0".repeat(64)
  const allowlistRequired = !!state.allowlistRoot && state.allowlistRoot.toLowerCase() !== zeroRoot
  const allowlistSatisfied = !allowlistRequired || options.allowlistProofAvailable === true
  const quantityValid = quantity >= 1n
  const soldOut = (collectionRemaining !== null && collectionRemaining <= 0n)
    || (saleRemaining !== null && saleRemaining <= 0n)
  const lifecycle = soldOut
    ? SurfaceStatus.Closed
    : lifecycleStatus({ mintStart: state.mintStart, mintEnd: state.mintEnd, supplyCap }, minted, nowSec)
  const mintable = lifecycle === SurfaceStatus.Open
    && quantityValid
    && allowlistSatisfied
    && !walletCapped
    && (remaining === null || quantity <= remaining)
    && (walletRemaining === null || quantity <= walletRemaining)
  return {
    effectiveCap,
    collectionRemaining,
    saleRemaining,
    remaining,
    walletRemaining,
    walletCapped,
    allowlistRequired,
    allowlistSatisfied,
    quantityValid,
    lifecycle,
    soldOut,
    mintable,
  }
}

export function sellsViaMinterOnly(idMode: IdMode): boolean {
  return idMode === IdMode.Pooled
}

export function quoteFixedPrice(unitPrice: bigint, quantity: bigint): bigint {
  if (quantity < 1n) throw new RangeError("Mint quantity must be at least one")
  return unitPrice * quantity
}

export function referralAmount(totalValue: bigint, referralShareBps: number): bigint {
  if (!Number.isInteger(referralShareBps) || referralShareBps < 0 || referralShareBps > 10_000) {
    throw new RangeError("Referral share must be an integer between 0 and 10000 bps")
  }
  return (totalValue * BigInt(referralShareBps)) / 10_000n
}
