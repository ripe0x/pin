import "server-only"
import type { PlatformAdapter, PlatformId } from "./types"
import { foundationAdapter } from "./foundation"
import { manifoldAdapter } from "./manifold"
import { sovereignAdapter } from "./sovereign"
import { superrareV2Adapter } from "./superrareV2"

/**
 * Registered platform adapters. The orchestrators in `onchain-discovery.ts`
 * (artist gallery), `last-sale.ts` (per-token sale lookup), `auctions.ts`
 * (bid history dispatch) loop this list. Adding a new platform = one
 * import + one entry here.
 *
 * Order matters for last-sale lookup ties: when two platforms claim a
 * sale for the same (contract, tokenId), the orchestrator picks the
 * more-recent one by blockTime, so order is just a stable tiebreaker.
 */
export const PLATFORMS: PlatformAdapter[] = [
  foundationAdapter,
  manifoldAdapter,
  sovereignAdapter,
  superrareV2Adapter,
]

export const PLATFORMS_BY_ID = Object.fromEntries(
  PLATFORMS.map((p) => [p.id, p]),
) as Record<PlatformId, PlatformAdapter>

export type { PlatformAdapter, PlatformId }
export {
  type ArtistTokenRef,
  type CollectorTokenRef,
  type AdapterLastSale,
  type SellerListings,
  type SellerCancellableAuction,
  type SellerCancellableBuyNow,
  type ActiveAuctionSummary,
} from "./types"
