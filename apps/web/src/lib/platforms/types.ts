import "server-only"
import type { Address } from "viem"
import type { AuctionState, BidHistoryEntry } from "../auctions"

/**
 * Platform adapter system. Each NFT platform we index implements this
 * interface; the orchestrator (artist gallery, last-sale, collector page)
 * loops the registry in `./index.ts`. Adding a new platform = one new
 * adapter file + one SQL migration + one line in the registry.
 *
 * The interface is intentionally minimal: only what the UI actually
 * needs. Optional methods let platforms implement the parts that apply
 * (a Manifold-only artist has no marketplace listings, but they have
 * tokens to discover).
 */

export type PlatformId =
  | "foundation"
  | "manifold"
  | "sovereign"
  | "superrareV2"
  // New platforms slot in here as they're added (superrareV1, zora, etc.)

// ── Tokens ─────────────────────────────────────────────────────────────

/**
 * One token an artist minted on a platform. The orchestrator unions the
 * per-platform results and dedupes by (contract, tokenId).
 *
 * `blockNumber` + `logIndex` are present when the platform's discovery
 * scans on-chain logs (Foundation Minted events, collection Transfer-
 * from-zero) and absent when discovery comes from an indexed-API
 * response that doesn't carry log context (Alchemy NFT API for Manifold).
 * Sort metadata is best-effort; the orchestrator falls back to
 * platform-defined ordering when null.
 */
export type ArtistTokenRef = {
  platform: PlatformId
  contract: Address
  tokenId: string
  blockNumber: bigint | null
  logIndex: number | null
  collectionName: string | null
}

/**
 * One token currently owned by a wallet on a platform. Used by the
 * collector page. `acquiredAtBlock` is best-effort — platforms that
 * surface it via `Transfer(to=wallet)` populate it; platforms that
 * resolve current ownership via a snapshot API (Alchemy
 * `getNFTsForOwner`) leave it 0n.
 */
export type CollectorTokenRef = {
  platform: PlatformId
  contract: Address
  tokenId: string
  ownerWallet: Address
  acquiredAtBlock: bigint
  acquiredTxHash: string | null
}

// ── Sales ──────────────────────────────────────────────────────────────

/**
 * Adapter-side last-sale type. Wider than the public `LastSale` in
 * `last-sale.ts` (which is consumed by `MoreFromContract` and only reads
 * priceWei + blockTime). The orchestrator in `last-sale.ts` maps this
 * back to the public type for callers that haven't been updated yet.
 *
 * `source` is platform-defined: "auction" | "buyNow" | "offer" | "primary"
 * etc. The UI doesn't currently render it, so adapters can use whatever
 * label is meaningful internally.
 */
export type AdapterLastSale = {
  platform: PlatformId
  priceWei: bigint
  blockTime: number
  source: string
  txHash: string
}

// ── Marketplace state (optional per platform) ──────────────────────────

export type SellerCancellableAuction = {
  id: string
  auctionId: string
  nftContract: string
  tokenId: string
  reserveWei: string
  durationSeconds: number
}

export type SellerCancellableBuyNow = {
  id: string
  nftContract: string
  tokenId: string
  priceWei: string
}

export type SellerListings = {
  auctions: SellerCancellableAuction[]
  buyNows: SellerCancellableBuyNow[]
}

/**
 * Summary row for an auction the home grid renders. Returned by
 * `getActiveAuctions` from any platform that has marketplace state.
 * `endTime` is unix-seconds; 0 means the auction has been created but
 * the timer hasn't started (no bids yet — sorts to tail).
 *
 * `sourceContract` is the marketplace address that holds the auction
 * (needed by token detail / bid panels to dispatch write txs).
 */
export type ActiveAuctionSummary = {
  platform: PlatformId
  contract: Address
  tokenId: string
  seller: Address
  reserveWei: bigint
  currentBidWei: bigint
  currentBidder: Address | null
  endTime: number
  sourceContract: Address
}

// ── The interface ──────────────────────────────────────────────────────

export interface PlatformAdapter {
  id: PlatformId
  displayName: string

  /**
   * Every token ever minted by `artist` on this platform. Lazy-cached
   * internally; first miss runs the platform's discovery scan, subsequent
   * misses return rows from `lazy_<id>_artist_tokens`.
   */
  discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]>

  /**
   * Tokens currently owned by `wallet` on this platform. Optional: a
   * platform that hasn't built collector-side support yet returns [] or
   * omits this method.
   */
  discoverCollectorTokens?(wallet: Address): Promise<CollectorTokenRef[]>

  /**
   * Most-recent sale for (contract, tokenId) recorded by this platform's
   * marketplace. Returns null if the token isn't on this platform or
   * has no sale.
   *
   * `creator` is optional context: Sovereign's RPC fallback uses it to
   * find the house address via `houseOf(creator)`. Other platforms can
   * ignore it. Pass null when the orchestrator doesn't have it.
   */
  getLastSale(
    contract: Address,
    tokenId: string,
    creator: Address | null,
  ): Promise<AdapterLastSale | null>

  // ── Optional: marketplace state ─────────────────────────────────────

  /**
   * Active auction for a token, if this platform has marketplace logic.
   * Returns null when the platform isn't escrowing this token in an
   * auction right now (or doesn't have a marketplace concept).
   */
  getActiveAuctionForToken?(
    contract: Address,
    tokenId: string,
  ): Promise<AuctionState | null>

  /**
   * Currently-active auctions on this platform, ordered ending-soonest-first
   * (with pre-bid auctions at the tail). Optional — platforms without a
   * marketplace return [] or omit.
   */
  getActiveAuctions?(limit: number): Promise<ActiveAuctionSummary[]>

  /**
   * Listings the seller can still cancel (no bids yet for auctions, or
   * still active for buy-now). Used by the migrate / bulk-delist panels.
   */
  getCancellableListingsForSeller?(
    seller: Address,
  ): Promise<SellerListings | null>

  /**
   * Newest-first bid history for an auction id.
   */
  getBidHistory?(
    auctionId: string,
  ): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">> | null>
}
