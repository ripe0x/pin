/**
 * Pure owner-transition rules shared by the Surface, FoundationNFT and
 * SuperRareNFT handlers. Kept free of ponder:registry/ponder:schema imports
 * so ownership.test.ts runs under plain node (see sovereignV2Status.ts for
 * the same pattern).
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

export const isZeroAddress = (address: string): boolean =>
  address.toLowerCase() === ZERO_ADDRESS

/**
 * collections.ownerConfirmed after a v2 OwnershipTransferred.
 *
 * - Renounce (newOwner == 0): only the current owner can call
 *   renounceOwnership(), so a renounce is never a third party's doing. Keep
 *   the previous value, or true when it was unset. Resetting it to false here
 *   would hide sealed collections (the strongest permanence state) from every
 *   listing that filters on `owner_confirmed IS NOT FALSE`.
 * - Otherwise OZ Ownable pushes ownership without the new owner's
 *   acceptance, so the new owner is confirmed only if it sent the
 *   transaction itself. A Safe or other contract owner therefore starts
 *   unconfirmed (tx.from is the executing EOA, not the Safe) and becomes
 *   confirmed on its first owner-only setter.
 */
export function ownerConfirmedAfterTransfer(
  previous: boolean | null | undefined,
  txFrom: string,
  newOwner: string,
): boolean {
  if (isZeroAddress(newOwner)) return previous ?? true
  return txFrom.toLowerCase() === newOwner.toLowerCase()
}

export type TransferKind = "mint" | "burn" | "transfer"

/** ERC-721 Transfer(from, to, tokenId) classified by its zero-address legs. */
export function classifyTransfer(from: string, to: string): TransferKind {
  if (isZeroAddress(from)) return "mint"
  if (isZeroAddress(to)) return "burn"
  return "transfer"
}

/**
 * What a Surface (v1 or v2) collection's Transfer does to
 * collection_tokens.owner. Both versions emit Transfer(0, to) from _mint
 * BEFORE their own Minted event, and Transfer(owner, 0) from _burn before
 * Burned, so:
 *
 * - mint: skip. The row does not exist yet (or, for a pooled re-mint, still
 *   holds the burned instance); the Minted handler writes owner = Minted.to,
 *   which equals the Transfer's `to` because nothing runs between the two.
 * - burn: owner = 0x0. Burned then flips `burned`.
 * - transfer: owner = to.
 *
 * Returns the owner to write, or null to leave the row untouched.
 */
export function surfaceOwnerAfterTransfer<A extends string>(from: string, to: A): A | null {
  return classifyTransfer(from, to) === "mint" ? null : to
}
