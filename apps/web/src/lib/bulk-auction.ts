/**
 * Most auctions one bulkCreateAuctions call carries. Mainnet caps a single
 * transaction at 16,777,216 gas (EIP-7825), and each auction costs about
 * 204k (escrow transfer plus a fresh Auction struct; 111 measured at 22.6M),
 * so 70 lands near 14.3M and leaves room for a wallet's estimate buffer.
 */
export const BULK_AUCTION_BATCH = 70

export function batches<T>(items: readonly T[], size = BULK_AUCTION_BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
