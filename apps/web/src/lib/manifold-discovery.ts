/**
 * v2 stub. v1's manifold-discovery.ts (924 lines) implemented per-artist
 * Etherscan + Alchemy scanning. That logic now lives in
 * apps/worker/src/scanners/manifold.ts. Web reads from `artist_tokens`
 * WHERE platform='manifold'.
 *
 * The few v1 call sites that still import from here resolve to no-ops;
 * the actual data path is `lib/onchain-discovery:discoverArtistTokenRefs`
 * which UNIONs artist_tokens.
 *
 * Delete when no callers remain.
 */
import "server-only"
import type { TokenRef } from "./onchain-discovery"

export async function discoverManifoldTokenRefs(
  _artistAddress: string,
): Promise<TokenRef[]> {
  // v1 returned per-artist Manifold token refs by scanning Alchemy +
  // Etherscan on cache miss. v2 reads from `artist_tokens` via
  // discoverArtistTokenRefs — this stub returns [] so legacy imports
  // resolve without re-introducing the eager-scan path.
  return []
}
