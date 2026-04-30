/**
 * Discover sibling tokens minted by the same creator on the same contract.
 *
 * Used by the token page to render "more from this artist on this contract"
 * below the auction panel. Reads from the same `getCachedTokenRefs` 24h
 * cache as the artist gallery so token-page loads don't repeat the discovery
 * scan.
 */
import { getCachedTokenRefs } from "./artist-cache"
import type { TokenRef } from "./onchain-discovery"

export type SiblingToken = TokenRef

export async function getTokensByContractAndCreator(
  nftContract: string,
  creator: string,
  options: { excludeTokenId?: string; limit?: number } = {},
): Promise<SiblingToken[]> {
  if (!creator) return []

  const limit = options.limit ?? 6
  const exclude = options.excludeTokenId
  const contractLower = nftContract.toLowerCase()

  const allRefs = await getCachedTokenRefs(creator).catch(
    () => [] as TokenRef[],
  )

  const siblings = allRefs.filter((ref) => {
    if (ref.contract.toLowerCase() !== contractLower) return false
    if (exclude && ref.tokenId === exclude) return false
    return true
  })

  return siblings.slice(0, limit)
}
