/**
 * Shared message-builder for the editions permanence writeback.
 *
 * Phase 1 of mint-funded permanence (docs/editions-permanence-funding.md). After
 * an artist deploys an edition with a permanence slice, the browser signs a
 * deterministic message via the artist's wallet and POSTs it to
 * `/api/editions/permanence`; the server recomputes the same message and
 * verifies the signature with viem's `verifyMessage`. Both sides MUST build the
 * message identically, so the canonical builder lives here (client- and
 * server-safe, no DB / enum imports).
 *
 * The format is human-readable so the wallet's signing UI shows the artist
 * exactly what they're attesting to (which edition routes which share to which
 * vault). The split is included so the server stores it and the edition page can
 * corroborate it for free against the edition's on-chain payoutAddress.
 *
 *   PND editions permanence v1
 *   edition=0x<lowercase 40-hex>
 *   split=0x<lowercase 40-hex>
 *   vault=0x<lowercase 40-hex>
 *   bps=<integer>
 *   nonce=<unix seconds>
 *
 * Nonce freshness reuses the /preserve writeback window (1 hour).
 */
import { isFreshNonce, WRITEBACK_NONCE_MAX_AGE_S } from "./preserve-writeback"

export { isFreshNonce, WRITEBACK_NONCE_MAX_AGE_S }

export type PermanenceWritebackPayload = {
  edition: string
  split: string
  vault: string
  bps: number
  nonce: number
}

export function buildPermanenceMessage(p: PermanenceWritebackPayload): string {
  return [
    "PND editions permanence v1",
    `edition=${p.edition.toLowerCase()}`,
    `split=${p.split.toLowerCase()}`,
    `vault=${p.vault.toLowerCase()}`,
    `bps=${p.bps}`,
    `nonce=${p.nonce}`,
  ].join("\n")
}

/** A 0x-prefixed 40-hex address string (case-insensitive). */
export function isAddressLike(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s)
}

/** Vault share in bps must leave room for the artist: 1..9999 (0.01%..99.99%). */
export function isValidPermanenceBps(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 9_999
}
