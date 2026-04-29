/**
 * Discover sibling tokens minted by the same creator on the same contract.
 *
 * Used by the token page to render "more from this artist on this contract"
 * below the auction panel. Reuses the artist-wide discovery from
 * `discoverArtistTokenRefs` and filters down to a single contract — the artist
 * gallery already pays this cost, so a hot cache is the common case.
 */
import {
  discoverArtistTokenRefs,
  type TokenRef,
} from "./onchain-discovery"

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

  const allRefs = await discoverArtistTokenRefs(creator).catch(
    () => [] as TokenRef[],
  )

  const siblings = allRefs.filter((ref) => {
    if (ref.contract.toLowerCase() !== contractLower) return false
    if (exclude && ref.tokenId === exclude) return false
    return true
  })

  return siblings.slice(0, limit)
}
