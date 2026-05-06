/**
 * RPC circuit breaker. When `RPC_DISABLED=1` is set on the deploy
 * environment, the most expensive server-side RPC fetchers
 * short-circuit to return cached-or-empty without firing any new
 * Alchemy traffic. Designed as an emergency kill switch when the
 * Alchemy bill is bleeding faster than we can patch individual
 * call sites.
 *
 * What's gated:
 *   - getFoundationLastSale      (eth_getLogs scans)
 *   - getSovereignLastSale       (eth_getLogs scans)
 *   - getTokenOnChainData        (only the deploy-to-head transfer log
 *                                 scan + per-block timestamp fan-out;
 *                                 ownerOf + tokenCreator still run so
 *                                 the artist + holder lines render)
 *   - discoverArtistTokens       (Alchemy NFT API + factory log scans)
 *
 * What stays operational:
 *   - /api/rpc proxy             (bidders need it for live state)
 *   - getAuctionForToken         (bid panel needs current state)
 *   - getFoundationBidHistory    (cursor-bounded already, cheap)
 *   - resolveTokenMetadataDirect (1h cached, cheap on miss)
 *   - ENS resolvers              (24h cached, cheap on miss)
 *   - Wagmi useReadContract      (browser-side, user-initiated)
 *
 * Effect when ON: token detail pages render with fresh ownerOf +
 * tokenCreator but cached-only provenance (no log-scan refresh) and
 * no last-sale refresh; artist pages render their cached gallery;
 * new tokens / new sales don't appear until you turn the switch off
 * again. Bidders can still bid.
 *
 * Toggle: set RPC_DISABLED=1 on Netlify env vars and redeploy.
 */
export function isRpcDisabled(): boolean {
  return process.env.RPC_DISABLED === "1"
}
