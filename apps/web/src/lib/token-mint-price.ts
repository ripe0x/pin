/**
 * Primary mint price for one Surface token, from the indexed
 * `collection_sales` rows (FixedPriceMinter / FixedPriceSale `Sold`), issue
 * #268 phase 2a. Pure (no server-only imports) so it is unit-testable; the
 * SELECT lives in token-mint-price.server.ts.
 *
 * Sold semantics (contracts/src/surface/interfaces/IMinter.sol and
 * v2/interfaces/IMinter.sol): one event per mint call, `quantity` tokens
 * minted to `to` with consecutive ids starting at `firstTokenId` (the
 * collection's mintTo return), `paid` the total settled for all of them
 * (v1: excluding any refunded excess; v2: price * quantity exactly). A token
 * id is covered by a sale when firstTokenId <= id < firstTokenId + quantity.
 *
 * This is the PRIMARY mint, never a secondary sale: label it as such.
 */
import { formatEther } from "viem"

export type IndexedSale = {
  firstTokenId: bigint
  quantity: bigint
  paid: bigint
  blockNumber: bigint
  txHash: string
}

export type TokenMintPrice = {
  /** paid / quantity, in wei (floored; exact for a fixed price). */
  perToken: bigint
  /** Tokens minted in the same call. */
  quantity: bigint
  /** Total paid for that call, in wei. */
  paid: bigint
  txHash: string
}

/** Does this sale's id span cover `tokenId`? */
export function saleCoversToken(sale: Pick<IndexedSale, "firstTokenId" | "quantity">, tokenId: bigint): boolean {
  if (sale.quantity <= 0n) return false
  return tokenId >= sale.firstTokenId && tokenId < sale.firstTokenId + sale.quantity
}

/**
 * The mint price of `tokenId` from the sales that may cover it. The latest
 * covering sale wins (a sequential id is minted once, so there is normally
 * exactly one; latest-wins only matters if a span were ever reused). Null
 * when no sale covers the id: minted through some other minter, or not
 * indexed yet. Never a guess.
 */
export function mintPriceForToken(sales: readonly IndexedSale[], tokenId: bigint): TokenMintPrice | null {
  let best: IndexedSale | null = null
  for (const s of sales) {
    if (!saleCoversToken(s, tokenId)) continue
    if (!best || s.blockNumber > best.blockNumber) best = s
  }
  if (!best) return null
  return { perToken: best.paid / best.quantity, quantity: best.quantity, paid: best.paid, txHash: best.txHash }
}

/** "Free" for a zero-price mint, else "0.05 ETH". */
export function formatMintPrice(p: Pick<TokenMintPrice, "perToken">): string {
  return p.perToken === 0n ? "Free" : `${formatEther(p.perToken)} ETH`
}
