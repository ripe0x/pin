import type { Address } from "viem"
import { IdMode, SurfaceStatus, type SaleWindow } from "./types.ts"

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
