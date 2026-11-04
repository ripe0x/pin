/**
 * What this site offers on the artist's Sovereign auction houses, by house
 * generation and lot type. Pure: no React, no chain reads, so the rules are
 * unit tested in auction-policy.test.ts.
 *
 * Mirrors the PND app's policy (apps/web/src/lib/auction-policy.ts in the
 * PND monorepo), adapted for the artist's own site. These are UI rules only:
 * the contracts are unchanged, anyone can still call a house directly, and
 * settlement paths (endAuction, claimLot, unwindStuckLot, returnUnwoundLot,
 * refund withdrawals) are never gated here.
 *
 * House generation comes from which factory deployed the house (lib/auctions
 * resolves the artist's house from each factory's AuctionHouseCreated log),
 * not from a getter: neither house version exposes a `version()` view.
 *
 * - V1 houses (SovereignAuctionHouse): `endAuction` delivers the lot inline,
 *   so a lot whose transfer starts failing after a bid keeps the winning bid
 *   in the house with no unwind path. V1 clones cannot be patched, so the
 *   site stops offering new bids on them. A V1 auction that already has a
 *   bid still settles here as usual.
 * - V2 houses, ERC-1155 lots: delivery runs the winner's `onERC1155Received`
 *   hook, which the winner controls, so settlement of this lot type can be
 *   held up until the 30-day unwind. Existing 1155 lots stay biddable with
 *   a note. (This site never creates listings; the PND app pauses new 1155
 *   listings on its side.)
 */
import type { HouseVersion, TokenStandard } from "./auction-status"

/** Whether the site offers the bid box on an auction from this house. */
export function canBid(houseVersion: HouseVersion): boolean {
  return houseVersion === 2
}

/** Whether a live auction should carry the "settlement can be delayed" note. */
export function showsSettlementDelayNote(auction: {
  houseVersion: HouseVersion
  standard: TokenStandard
}): boolean {
  return auction.houseVersion === 2 && auction.standard === "erc1155"
}

export const V1_BIDS_PAUSED_NOTICE =
  "New bids on this auction are paused while the artist moves to the current PND auction house."

/** Follow-up line for a V1 auction that already has a bid. */
export const V1_BID_STANDS_NOTE =
  "The current bid stands, and the auction settles here as usual once it ends."

export const ERC1155_SETTLEMENT_NOTE =
  "Settlement for ERC-1155 lots can be delayed. If delivery to the winner fails, nobody is paid until a retry succeeds or the sale unwinds after 30 days."
