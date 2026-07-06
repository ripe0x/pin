/**
 * Sovereign Collection — shared, client-safe helpers.
 *
 * Enums, types, ABI-return decoders, and lifecycle helpers used by both the
 * server-only cached reads (lib/collection.ts) and client components
 * (components/CollectionMintCard.tsx). No server-only imports — this mirrors
 * the split in the foundation monorepo's apps/web/src/lib/sovereign-collection.ts
 * (client-safe) vs. lib/collection-onchain.ts (server-only reads).
 */
import { type Address } from "viem"

/** Mirrors CollectionTypes.sol CollectionStatus. */
export enum CollectionStatus {
  Open = 0,
  Closing = 1,
  Closed = 2,
}

/** Mirrors CollectionTypes.sol IdMode. */
export enum IdMode {
  Sequential = 0,
  Pooled = 1,
}

export type CollectionConfig = {
  artworkURI: string
  price: bigint
  supplyCap: bigint
  mintStart: bigint
  mintEnd: bigint
  royaltyBps: number
  royaltyReceiver: Address
  kind: number
  payoutAddress: Address
  renderer: Address
  mintHook: Address
  priceStrategy: Address
  idMode: IdMode
}

export type CollectionSummary = {
  address: Address
  name: string
  symbol: string
  cfg: CollectionConfig
  status: CollectionStatus
  minted: bigint
}

export type RawCollectionConfig = {
  artworkURI: string
  price: bigint
  supplyCap: bigint
  mintStart: bigint
  mintEnd: bigint
  royaltyBps: number
  royaltyReceiver: Address
  kind: number
  payoutAddress: Address
  renderer: Address
  mintHook: Address
  priceStrategy: Address
  idMode: number
}

export function decodeCollectionConfig(raw: RawCollectionConfig): CollectionConfig {
  return {
    artworkURI: raw.artworkURI,
    price: raw.price,
    supplyCap: raw.supplyCap,
    mintStart: raw.mintStart,
    mintEnd: raw.mintEnd,
    royaltyBps: Number(raw.royaltyBps),
    royaltyReceiver: raw.royaltyReceiver,
    kind: Number(raw.kind),
    payoutAddress: raw.payoutAddress,
    renderer: raw.renderer,
    mintHook: raw.mintHook,
    priceStrategy: raw.priceStrategy,
    idMode: Number(raw.idMode) as IdMode,
  }
}

/**
 * True when a price strategy contract is set (its live `currentPrice()`
 * quote overrides the stored `cfg.price`).
 */
export function hasPriceStrategy(priceStrategy: Address): boolean {
  return priceStrategy.toLowerCase() !== "0x0000000000000000000000000000000000000000"
}

/**
 * Lifecycle status derived client-side, same branches as
 * SovereignCollection._lifecycleStatus(): mintEnd passed or supply cap
 * reached both read as Closed; an artist-flagged "closing soon" state would
 * come from the live `status` read (there's no local signal for it), so this
 * helper only ever returns Open or Closed — Closing is read from chain.
 */
export function isMintable(
  cfg: Pick<CollectionConfig, "mintStart" | "mintEnd" | "supplyCap">,
  minted: bigint,
  nowSec: number,
): boolean {
  if (cfg.mintStart !== 0n && BigInt(nowSec) < cfg.mintStart) return false
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return false
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return false
  return true
}

/**
 * The token ids of the most recently minted tokens (newest first), capped at
 * 12. Sequential id-mode only: ids are exactly 1..minted (the core assigns
 * `nextId++`, never reused after burn — see IdMode.Sequential in
 * CollectionTypes.sol), so "the last N ids" is a correct read of "the last N
 * mints", same assumption apps/web/src/lib/collection-onchain.ts's
 * getCollectionMintHistory relies on. Callers should check
 * `cfg.idMode === IdMode.Sequential` before using this (Pooled collections
 * have no id-order invariant).
 *
 * Deliberately returns ids only, not tokenURI/metadata — `lib/metadata.ts`'s
 * `getTokenMetadata` already owns the tokenURI read + parse + cache for
 * every other token surface on this page (AuctionCard included); reusing it
 * here means one code path handles `data:` URIs, IPFS gateways, and the
 * malformed-metadata guards, instead of a second parser drifting from it.
 */
export function recentTokenIds(minted: bigint, limit = 12): bigint[] {
  const total = Number(minted)
  if (total <= 0) return []
  const count = Math.min(total, limit)
  return Array.from({ length: count }, (_, i) => BigInt(total - i))
}
