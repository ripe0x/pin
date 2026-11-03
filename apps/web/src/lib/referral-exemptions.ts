/**
 * The one list of collections whose mints on PND pass no referrer. Every
 * other PND mint pays the referral share to PND. Each entry is a
 * deal-specific exception, not a setting: PND is already paid through the
 * collection's payout split.
 *
 * Both mint surfaces read this list: the collection page (through
 * lib/collection.ts:mintReferrerFor) and the bespoke /mint/<slug> page args
 * builders under lib/mint-modules. Add or remove an exemption here only.
 *
 * Dependency-free on purpose, so a client mint module can import it without
 * pulling in the collection read layer.
 */
export const NO_REFERRAL_COLLECTIONS: ReadonlySet<string> = new Set([
  // Form of Solitude (Anton Dubrovin), mainnet: PND takes 20% through the
  // 80/20 payout split (Dave, 2026-11-02). Do not copy this to other
  // collections.
  "0x4490f1dadefa3234961404f5cc58056296eb4a89",
])

/** True when PND mints of `collection` (the token contract, any case) pass
 *  no referrer. */
export function isNoReferralCollection(collection: string): boolean {
  return NO_REFERRAL_COLLECTIONS.has(collection.toLowerCase())
}
