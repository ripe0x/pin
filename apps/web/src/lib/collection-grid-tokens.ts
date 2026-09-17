/**
 * Which token ids the post-mint collection grid shows: the indexer's
 * newest-first ids when it has rows for this collection, else a sequential
 * 1..min(minted, cap) fallback for a collection the indexer hasn't caught
 * up to yet (or a local/fork environment with no indexer at all). Capped
 * either way so the grid never renders, or fetches a render for, more ids
 * than it displays.
 */
export function selectGridTokenIds(indexedIds: number[], minted: bigint, cap = 12): number[] {
  if (indexedIds.length > 0) return indexedIds.slice(0, cap)
  if (minted <= 0n) return []
  const count = minted < BigInt(cap) ? Number(minted) : cap
  return Array.from({ length: count }, (_, i) => i + 1)
}
