/**
 * Most auctions one bulkCreateAuctions call carries. Each auction escrows a
 * token and writes a fresh Auction struct, so a few hundred in one call can
 * pass the block gas limit or a wallet's own cap.
 */
export const BULK_AUCTION_BATCH = 100

export function batches<T>(items: readonly T[], size = BULK_AUCTION_BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
