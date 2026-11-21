/**
 * What the PND UI offers on Sovereign auction houses, by house generation
 * and lot type. Pure: no React, no chain reads, so the rules are unit
 * tested in auction-policy.test.ts and shared by every bid / listing
 * entry point (AuctionPanel, AuctionTermsForm, SovereignBulkPanel,
 * StartAuctionCTA, /auction/new).
 *
 * These are UI rules only. The contracts are unchanged: anyone can still
 * call a house directly, and settlement paths (endAuction, claimLot,
 * unwindStuckLot, returnUnwoundLot, cancel, refunds) are never gated here.
 *
 * - V1 houses (SovereignAuctionHouse): `endAuction` delivers the lot
 *   inline, so a lot whose transfer starts failing after a bid keeps the
 *   winning bid in the house with no unwind path (issue #289). V1 clones
 *   cannot be patched, so PND stops offering new bids and new listings on
 *   them and points owners at the V2 upgrade flow instead.
 * - V2 houses, ERC-1155 lots: delivery runs the winner's
 *   `onERC1155Received` hook, which the winner controls, so settlement of
 *   this lot type can be held up until the 30-day unwind. New 1155
 *   listings are paused in the PND UI pending a house update; existing
 *   ones stay biddable with a note.
 */

export type HouseVersion = 1 | 2
export type TokenStandard = "erc721" | "erc1155"

/** Flip to re-enable new ERC-1155 lot listings once a house update ships. */
export const ERC1155_LISTINGS_ENABLED = false

/** Minimal listing shape the bid rule needs (AuctionState satisfies it). */
export type BidPolicyListing = {
  source: "foundation" | "sovereign" | "superrareV2" | "transient"
  houseVersion: HouseVersion
}

/**
 * Whether PND offers the bid box on a listing. Only Sovereign V1 houses
 * are excluded. Non-sovereign sources carry `houseVersion: 1` as a
 * placeholder, so the source check comes first.
 */
export function canBid(listing: BidPolicyListing): boolean {
  if (listing.source !== "sovereign") return true
  return listing.houseVersion === 2
}

export type ListingBlockReason = "v1-house" | "erc1155-paused"

/**
 * Why PND won't create a new listing of `standard` on a house of
 * `houseVersion`, or null when it will.
 */
export function listingBlockReason(
  houseVersion: HouseVersion,
  standard: TokenStandard,
): ListingBlockReason | null {
  if (houseVersion !== 2) return "v1-house"
  if (standard === "erc1155" && !ERC1155_LISTINGS_ENABLED) return "erc1155-paused"
  return null
}

export function canListStandard(
  houseVersion: HouseVersion,
  standard: TokenStandard,
): boolean {
  return listingBlockReason(houseVersion, standard) === null
}

/** Whether a live listing should carry the "settlement can be delayed" note. */
export function showsSettlementDelayNote(listing: BidPolicyListing & {
  tokenStandard: TokenStandard
}): boolean {
  return (
    listing.source === "sovereign" &&
    listing.houseVersion === 2 &&
    listing.tokenStandard === "erc1155"
  )
}

export const V1_BIDS_PAUSED_NOTICE =
  "This auction runs on a first-version PND auction house. New bids are paused on PND while sellers move to the current house."

export const V1_LISTINGS_PAUSED_NOTICE =
  "New listings aren't available on first-version PND auction houses. Upgrade to the current house to list."

export const ERC1155_LISTINGS_PAUSED_NOTICE =
  "ERC-1155 lots aren't available on PND auction houses yet."

export const ERC1155_SETTLEMENT_NOTE =
  "Settlement for ERC-1155 lots can be delayed. If delivery to the winner fails, nobody is paid until a retry succeeds or the sale unwinds after 30 days."

// ── account code classification (deferred-delivery winner flag) ─────────

export type AccountCodeKind = "eoa" | "contract" | "delegated"

/** EIP-7702 delegation designator prefix: 0xef0100 ‖ 20-byte address. */
const EIP7702_PREFIX = "0xef0100"

/**
 * Classifies an `eth_getCode` result. Empty code is a plain account; an
 * EIP-7702 designator is an account delegating to contract code; anything
 * else is a contract. Both of the latter run code when they receive a lot.
 */
export function classifyAccountCode(
  code: `0x${string}` | string | null | undefined,
): AccountCodeKind {
  if (!code || code === "0x") return "eoa"
  const lower = code.toLowerCase()
  if (lower.startsWith(EIP7702_PREFIX) && lower.length === 2 + 46) return "delegated"
  return "contract"
}

export function winnerCodeNote(kind: AccountCodeKind | null): string | null {
  if (kind === "contract") return "Winning bidder is a contract account."
  if (kind === "delegated") return "Winning bidder is an account delegated to contract code (EIP-7702)."
  return null
}
