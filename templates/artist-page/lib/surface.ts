/** Shared, client-safe Surface shapes used by the self-hosted artist site. */
import {
  IdMode,
  hasPriceStrategy,
  isMintable,
  lifecycleStatus,
  type SaleWindow,
} from "@pin/surface-kit"
import { type Address, type Hex } from "viem"

export { IdMode, hasPriceStrategy, isMintable, lifecycleStatus }
export type { SaleWindow }

export type CollectionConfig = {
  supplyCap: bigint
  royaltyBps: number
  royaltyReceiver: Address
  renderer: Address
  rendererLocked: boolean
  supplyLocked: boolean
}

export type MinterSaleConfig = {
  minter: Address
  price: bigint
  priceStrategy: Address
  mintStart: bigint
  mintEnd: bigint
  maxMints: bigint
  totalMinted: bigint
  allowlistRoot: Hex
  walletCap: bigint
  referralShareBps: number
}

export type CollectionSummary = {
  address: Address
  name: string
  symbol: string
  cfg: CollectionConfig
  idMode: IdMode
  primaryMinter: Address | null
  sale: MinterSaleConfig | null
  minted: bigint
}

export type RawCollectionConfig = {
  supplyCap: bigint
  royaltyBps: number
  royaltyReceiver: Address
  renderer: Address
  rendererLocked: boolean
  supplyLocked: boolean
}

export function decodeCollectionConfig(raw: RawCollectionConfig): CollectionConfig {
  return {
    supplyCap: raw.supplyCap,
    royaltyBps: Number(raw.royaltyBps),
    royaltyReceiver: raw.royaltyReceiver,
    renderer: raw.renderer,
    rendererLocked: raw.rendererLocked,
    supplyLocked: raw.supplyLocked,
  }
}

export function saleWindowOf(
  cfg: Pick<CollectionConfig, "supplyCap">,
  sale: Pick<MinterSaleConfig, "mintStart" | "mintEnd"> | null,
): SaleWindow {
  return {
    supplyCap: cfg.supplyCap,
    mintStart: sale?.mintStart ?? 0n,
    mintEnd: sale?.mintEnd ?? 0n,
  }
}

/** Recent sequential token ids, newest first, without any token-grid RPC fan-out. */
export function recentTokenIds(minted: bigint, limit = 12): bigint[] {
  const total = Number(minted)
  if (total <= 0) return []
  const count = Math.min(total, limit)
  return Array.from({ length: count }, (_, i) => BigInt(total - i))
}
