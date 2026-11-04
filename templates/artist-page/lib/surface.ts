/**
 * Surface collections — shared, client-safe types and pure helpers.
 *
 * Used by both the server-only cached read (lib/collection.ts) and the client
 * mint card (components/CollectionMintCard.tsx). No server-only imports here.
 *
 * Two contract generations are supported, both "thin token": the token holds
 * the art pointer and the supply cap, and a separate sale contract holds the
 * price, the window and the money.
 *
 *   v1  Surface (`version() == 1`) + its canonical FixedPriceMinter clone,
 *       found through the token's `primaryMinter()`. Mint is
 *       `mint(to, quantity, referrer, data)`. The referral share is the
 *       minter's `referralShareBps()` (10% at launch, artist-settable, never
 *       above 10%).
 *   v2  Surface (`version() == 2`) + a FixedPriceSale clone in the token's
 *       single `minter()` slot. Mint is
 *       `mintWithReferral(to, quantity, referrer, data)`. The referral share
 *       is the sale's `REFERRAL_SHARE_BPS` constant: 5%, fixed.
 *
 * Anything else (a pre-thin-token collection, a bespoke minter, no minter)
 * renders without a mint button.
 */
import { type Address } from "viem"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
export const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const

/**
 * ERC-165 id of the v2 `IMinter` (contracts/src/surface/v2/interfaces/IMinter.sol):
 * mint(uint256) ^ mintWithReferral(address,uint256,address,bytes) ^
 * priceOf(address,uint256). A client reading a v2 collection's `minter()`
 * checks this to tell a canonical sale from a bespoke minter.
 */
export const V2_IMINTER_INTERFACE_ID = "0x5a77ac74" as const

/** FixedPriceSale.REFERRAL_SHARE_BPS: a constant, no setter, no init param. */
export const V2_REFERRAL_SHARE_BPS = 500

/** The public PND collection page, where allowlist proofs are served. */
export function pndCollectionUrl(collection: Address): string {
  return `https://pnd.fyi/collections/${collection}`
}

export type SaleKind = "v1-fixed-price" | "v2-fixed-price"

/** The live state of a collection's canonical sale contract. */
export type SaleState = {
  kind: SaleKind
  /** The sale (v2) or minter clone (v1) that receives the mint call. */
  address: Address
  /** Stored per-token price in wei. For a v1 price-strategy sale this is
   *  the fallback, not the quote: read `quote1` / `priceOf` instead. */
  price: bigint
  /** Live `priceOf(0x0, 1)` at read time: the per-token price to display. */
  quote1: bigint
  /** v1 only: a price-strategy contract, or null for a fixed price. */
  priceStrategy: Address | null
  mintStart: bigint
  mintEnd: bigint
  /** This sale's own ceiling (0 = unlimited), separate from supplyCap. */
  maxMints: bigint
  totalMinted: bigint
  /** Per-recipient cap (0 = unlimited). */
  walletCap: bigint
  /** True when minting needs gate data the template cannot produce: a v1
   *  allowlist root or any v2 gate. */
  gated: boolean
  /** v2 `close()` is one-way; always false on v1 (which has no close). */
  closed: boolean
  referralShareBps: number
  payoutRecipient: Address
}

export type CollectionSummary = {
  address: Address
  name: string
  symbol: string
  /** The token's own `version()`; 0 when it has none (not a thin-token
   *  Surface, so no mint path is offered). */
  protocolVersion: 0 | 1 | 2
  /** Zero once ownership is renounced (v2's permanence mechanism). */
  owner: Address
  supplyCap: bigint
  /** Lifetime mint count (token ids are 1..minted). */
  minted: bigint
  /** True when token ids are exactly 1..minted (v1 Sequential, every v2),
   *  which is what the recent-mints grid relies on. */
  sequential: boolean
  /** The token's minter slot (v2) or primary minter (v1); null when unset. */
  minter: Address | null
  /** The canonical sale behind `minter`, or null when there is none or it
   *  is not one this template knows how to drive. */
  sale: SaleState | null
}

// ── bigint-safe serialization ────────────────────────────────────────────────
//
// Next.js cannot serialize a bigint across the server/client boundary, and
// `unstable_cache` JSON-stringifies its return value (JSON.stringify throws on
// bigint). Every bigint crosses as a decimal string and is rebuilt here.

type Stringified<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] }
export type SerializedSaleState = Stringified<SaleState>
export type SerializedCollectionSummary = Omit<Stringified<CollectionSummary>, "sale"> & {
  sale: SerializedSaleState | null
}

export function serializeCollection(c: CollectionSummary): SerializedCollectionSummary {
  return {
    ...c,
    supplyCap: c.supplyCap.toString(),
    minted: c.minted.toString(),
    sale: c.sale
      ? {
          ...c.sale,
          price: c.sale.price.toString(),
          quote1: c.sale.quote1.toString(),
          mintStart: c.sale.mintStart.toString(),
          mintEnd: c.sale.mintEnd.toString(),
          maxMints: c.sale.maxMints.toString(),
          totalMinted: c.sale.totalMinted.toString(),
          walletCap: c.sale.walletCap.toString(),
        }
      : null,
  }
}

export function deserializeCollection(c: SerializedCollectionSummary): CollectionSummary {
  return {
    ...c,
    supplyCap: BigInt(c.supplyCap),
    minted: BigInt(c.minted),
    sale: c.sale
      ? {
          ...c.sale,
          price: BigInt(c.sale.price),
          quote1: BigInt(c.sale.quote1),
          mintStart: BigInt(c.sale.mintStart),
          mintEnd: BigInt(c.sale.mintEnd),
          maxMints: BigInt(c.sale.maxMints),
          totalMinted: BigInt(c.sale.totalMinted),
          walletCap: BigInt(c.sale.walletCap),
        }
      : null,
  }
}

// ── sale state ───────────────────────────────────────────────────────────────

/**
 * How many more tokens can be minted through this sale: the tighter of the
 * collection's supply cap and the sale's own maxMints (both 0 = no limit).
 * Null means unlimited.
 */
export function remainingSupply(
  c: Pick<CollectionSummary, "supplyCap" | "minted">,
  sale: Pick<SaleState, "maxMints" | "totalMinted"> | null,
): bigint | null {
  const caps: bigint[] = []
  if (c.supplyCap > 0n) caps.push(c.supplyCap - c.minted)
  if (sale && sale.maxMints > 0n) caps.push(sale.maxMints - sale.totalMinted)
  if (caps.length === 0) return null
  const min = caps.reduce((a, b) => (b < a ? b : a))
  return min < 0n ? 0n : min
}

export type SalePhase = "not-started" | "open" | "ended" | "closed" | "sold-out"

/**
 * The sale's phase, in the order the contracts check it: closed (v2 only),
 * then the window, then the caps. `mintEnd` is exclusive, matching
 * `block.timestamp >= mintEnd` in both sale contracts.
 */
export function salePhase(
  c: Pick<CollectionSummary, "supplyCap" | "minted">,
  sale: Pick<SaleState, "closed" | "mintStart" | "mintEnd" | "maxMints" | "totalMinted">,
  nowSec: number,
): SalePhase {
  if (sale.closed) return "closed"
  const now = BigInt(nowSec)
  if (sale.mintStart !== 0n && now < sale.mintStart) return "not-started"
  if (sale.mintEnd !== 0n && now >= sale.mintEnd) return "ended"
  const left = remainingSupply(c, sale)
  if (left !== null && left <= 0n) return "sold-out"
  return "open"
}

/**
 * The address this site passes as the mint referrer. Order:
 *   1. NEXT_PUBLIC_MINT_REFERRER, when set (the zero address is allowed and
 *      means "no referrer": the whole payment goes to the payout recipient);
 *   2. the collection's owner, while it has one;
 *   3. the site's artist address (a renounced collection has no owner).
 * On the artist's own site the referral share therefore lands back with the
 * artist instead of any platform.
 */
export function resolveReferrer({
  configured,
  owner,
  artist,
}: {
  configured: Address | null
  owner: Address
  artist: Address
}): Address {
  if (configured) return configured
  if (owner.toLowerCase() !== ZERO_ADDRESS) return owner
  return artist
}

/**
 * The token ids of the most recently minted tokens (newest first), capped at
 * `limit`. Only valid when `sequential` is true: ids are exactly 1..minted
 * and never reused after a burn, so "the last N ids" is "the last N mints".
 * A burned id's tokenURI reverts; the metadata read degrades to a title-only
 * card for it.
 */
export function recentTokenIds(minted: bigint, limit = 12): bigint[] {
  const total = Number(minted)
  if (total <= 0) return []
  const count = Math.min(total, limit)
  return Array.from({ length: count }, (_, i) => BigInt(total - i))
}
