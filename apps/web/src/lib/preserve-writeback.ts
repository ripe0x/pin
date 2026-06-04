/**
 * Shared message-builder for the /preserve writeback flow.
 *
 * The browser signs a deterministic message via the artist's wallet
 * (`useSignMessage` / `walletClient.signMessage`); the server
 * recomputes the same message and verifies the signature with viem's
 * `verifyMessage`. Both sides MUST construct the message identically,
 * so the canonical builder lives here, server-and-client safe.
 *
 * The format is intentionally human-readable so the wallet's signing
 * UI shows the artist what they're attesting to (which CIDs at which
 * provider). A nonce (unix seconds) gives the server something to
 * range-check for freshness — accepted only within 1 hour.
 *
 *   PND preserve writeback v1
 *   artist=0x<lowercase 40-hex>
 *   cids=<sorted comma-separated>
 *   provider=<pinata|4everland|web3storage>
 *   nonce=<unix seconds>
 *
 * The CID list is sorted before concatenation so client and server
 * derive the same string regardless of insertion order.
 */

export type ProviderId = "pinata" | "4everland" | "web3storage"

export const WRITEBACK_NONCE_MAX_AGE_S = 60 * 60 // 1 hour

export type WritebackPayload = {
  artist: string
  cids: string[]
  provider: ProviderId
  nonce: number
}

export function buildWritebackMessage(p: WritebackPayload): string {
  const artist = p.artist.toLowerCase()
  const sorted = [...p.cids].sort()
  return [
    "PND preserve writeback v1",
    `artist=${artist}`,
    `cids=${sorted.join(",")}`,
    `provider=${p.provider}`,
    `nonce=${p.nonce}`,
  ].join("\n")
}

export function isFreshNonce(nonce: number, nowSeconds: number): boolean {
  if (!Number.isFinite(nonce)) return false
  const age = nowSeconds - nonce
  // Reject future-dated nonces (clock-skew slop ≤ 5 minutes) and
  // anything older than the window.
  return age >= -5 * 60 && age <= WRITEBACK_NONCE_MAX_AGE_S
}

export function isValidProvider(s: string): s is ProviderId {
  return s === "pinata" || s === "4everland" || s === "web3storage"
}
