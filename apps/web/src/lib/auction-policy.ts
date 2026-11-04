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
 *   listings are paused in the PND UI on V2 houses; existing ones stay
 *   biddable with a note.
 * - V2.1 houses (SovereignAuctionHouseV2_1, from the V2.1 factory): same
 *   ABI as V2, so `houseVersion` is 2 and every V2 surface applies. When
 *   delivery to the winner fails but the lot can still move, the sale
 *   settles anyway (seller paid) and the lot is held for the winner to
 *   claim to any address. That removes the winner-controlled delay, so
 *   ERC-1155 listings are allowed on V2.1 houses. `houseIsV2_1` marks
 *   them; it is false everywhere until the V2.1 factory is deployed.
 */

/**
 * Generation of the house ABI and UI. V2.1 houses are 2 here (their
 * `auctionVersion()` returns 2 and they keep V2's ABI); `houseIsV2_1`
 * carries the settlement difference.
 */
export type HouseVersion = 1 | 2
export type TokenStandard = "erc721" | "erc1155"

/**
 * Flip to re-enable new ERC-1155 lot listings on V2 houses. V2.1 houses
 * allow them regardless (see listingBlockReason).
 */
export const ERC1155_LISTINGS_ENABLED = false

/** Minimal listing shape the bid rule needs (AuctionState satisfies it). */
export type BidPolicyListing = {
  source: "foundation" | "sovereign" | "superrareV2" | "transient"
  houseVersion: HouseVersion
  /** True only for a V2.1 house (implies houseVersion 2). */
  houseIsV2_1?: boolean
}

/**
 * pnd_houses.version / pnd_auctions.version as apps/indexer writes them:
 * 1 = V1, 2 = V2, 21 = V2.1. Maps the indexer value onto the UI's house
 * generation plus the V2.1 flag. Any other value (missing column, a
 * future generation this build does not know) folds to V1 semantics,
 * which offers the least: no bids, no listings.
 */
export function houseFromIndexerVersion(version: number | null | undefined): {
  houseVersion: HouseVersion
  houseIsV2_1: boolean
} {
  const v = Number(version)
  if (v === 21) return { houseVersion: 2, houseIsV2_1: true }
  if (v === 2) return { houseVersion: 2, houseIsV2_1: false }
  return { houseVersion: 1, houseIsV2_1: false }
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
 * `houseVersion`, or null when it will. `houseIsV2_1` lifts the ERC-1155
 * pause: a V2.1 house settles a refused 1155 delivery by holding the lot
 * for the winner instead of waiting on the winner's hook.
 */
export function listingBlockReason(
  houseVersion: HouseVersion,
  standard: TokenStandard,
  houseIsV2_1 = false,
): ListingBlockReason | null {
  if (houseVersion !== 2) return "v1-house"
  if (standard === "erc1155" && !ERC1155_LISTINGS_ENABLED && !houseIsV2_1) return "erc1155-paused"
  return null
}

export function canListStandard(
  houseVersion: HouseVersion,
  standard: TokenStandard,
  houseIsV2_1 = false,
): boolean {
  return listingBlockReason(houseVersion, standard, houseIsV2_1) === null
}

/**
 * Whether a live listing should carry the "settlement can be delayed"
 * note: sovereign V2 ERC-1155 lots only. Not on V2.1, whose settlement
 * does not wait on the winner (see `settlementNoteFor`).
 */
export function showsSettlementDelayNote(listing: BidPolicyListing & {
  tokenStandard: TokenStandard
}): boolean {
  return (
    listing.source === "sovereign" &&
    listing.houseVersion === 2 &&
    !listing.houseIsV2_1 &&
    listing.tokenStandard === "erc1155"
  )
}

/**
 * Whether a live listing should explain V2.1's held-for-winner settlement:
 * sovereign V2.1 ERC-1155 lots (the lot type whose delivery runs the
 * winner's own receiver code).
 */
export function showsHeldForWinnerNote(listing: BidPolicyListing & {
  tokenStandard: TokenStandard
}): boolean {
  return (
    listing.source === "sovereign" &&
    listing.houseVersion === 2 &&
    listing.houseIsV2_1 === true &&
    listing.tokenStandard === "erc1155"
  )
}

/** The settlement note a live listing carries, or null for none. */
export function settlementNoteFor(listing: BidPolicyListing & {
  tokenStandard: TokenStandard
}): string | null {
  if (showsSettlementDelayNote(listing)) return ERC1155_SETTLEMENT_NOTE
  if (showsHeldForWinnerNote(listing)) return ERC1155_HELD_FOR_WINNER_NOTE
  return null
}

export const V1_BIDS_PAUSED_NOTICE =
  "This auction runs on a first-version PND auction house. New bids are paused on PND while sellers move to the current house."

export const V1_LISTINGS_PAUSED_NOTICE =
  "New listings aren't available on first-version PND auction houses. Upgrade to the current house to list."

export const ERC1155_LISTINGS_PAUSED_NOTICE =
  "ERC-1155 lots aren't available on PND auction houses yet."

/** Shown instead when a V2.1 house could take the lot (V2.1 factory live). */
export const ERC1155_LISTINGS_NEED_V2_1_NOTICE =
  "ERC-1155 lots need the current PND auction house. This house is an earlier version."

export const ERC1155_SETTLEMENT_NOTE =
  "Settlement for ERC-1155 lots can be delayed. If delivery to the winner fails, nobody is paid until a retry succeeds or the sale unwinds after 30 days."

export const ERC1155_HELD_FOR_WINNER_NOTE =
  "If the lot can't be delivered to the winner's address, the sale still completes: the seller is paid and the lot is held in the auction house for the winner, who can claim it to any address at any time."

// ── held-for-winner status (V2.1) ───────────────────────────────────────

/** pnd_auctions.status for a V2.1 sale settled with the lot held for the winner. */
export const HELD_FOR_WINNER = "held_for_winner" as const

/**
 * pnd_auctions statuses that are completed sales (seller paid): "settled",
 * and V2.1's "held_for_winner" (paid at the hammer, lot not yet claimed).
 * SQL fragment for `status IN ...` in sale, volume and activity reads.
 */
export const PND_SOLD_STATUSES_SQL = "('settled', 'held_for_winner')"

/**
 * Status the auction page shows for a sovereign row. The indexer writes
 * "held_for_winner" itself; this covers a V2.1 row that reads "settled"
 * without a recorded claim (an indexer that predates the status) by
 * trusting an onchain `heldForWinner(id)` read. `heldOnchain` is only
 * consulted for V2.1 houses and only when the caller could read it.
 */
export function resolveHeldForWinner<S extends string>(args: {
  status: S
  houseIsV2_1: boolean
  claimRecipient: string | null
  heldOnchain: boolean | null
}): S | typeof HELD_FOR_WINNER {
  if (args.status === HELD_FOR_WINNER) return HELD_FOR_WINNER
  if (
    args.houseIsV2_1 &&
    args.status === "settled" &&
    args.claimRecipient == null &&
    args.heldOnchain === true
  ) {
    return HELD_FOR_WINNER
  }
  return args.status
}

/** Whether the page should spend the onchain heldForWinner read on this row. */
export function needsHeldForWinnerRead(args: {
  status: string
  houseIsV2_1: boolean
  claimRecipient: string | null
}): boolean {
  return args.houseIsV2_1 && args.status === "settled" && args.claimRecipient == null
}

/** Recipient check for claimLot(id, to) on a held lot. */
export function claimRecipientError(
  to: string,
  house: string,
): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return "Enter a full 0x address."
  if (/^0x0{40}$/i.test(to)) return "The zero address can't receive the lot."
  if (to.toLowerCase() === house.toLowerCase()) return "The auction house itself can't receive the lot."
  return null
}

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
