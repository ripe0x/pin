import { extractArweaveId, extractBareCid } from "@pin/shared"

/**
 * Pure classification + status mapping for the Phase 4 honest-status read.
 * No server-only / DB imports, so it is unit-testable in isolation
 * (see editions-persistence-status.test.ts). The DB-backed read that consumes
 * these lives in editions-persistence.ts.
 */

export type ArtworkPersistenceKind = "ipfs" | "arweave" | "external" | "none"

export type ArtworkPersistenceStatus =
  | "retrievable" // a public gateway served it at the last probe
  | "unretrievable" // probe ran; no gateway served it
  | "artist-pinned" // artist attested a pin; not yet gateway-verified
  | "unprobed" // content-addressed but not yet checked
  | "external" // a single-host URL, not a content-addressed CID
  | "none" // no artwork URI

/**
 * Classify an artwork URI into its content-address cache key. `key` is the CID
 * / Arweave tx id used to look up cid_availability + token_pins; null when the
 * URI is empty (none) or a plain non-content-addressed URL (external).
 */
export function classifyArtworkKey(
  artworkURI: string,
): { kind: ArtworkPersistenceKind; key: string | null } {
  const uri = (artworkURI ?? "").trim()
  if (!uri) return { kind: "none", key: null }
  const cid = extractBareCid(uri)
  if (cid) return { kind: "ipfs", key: cid }
  const arId = extractArweaveId(uri)
  if (arId) return { kind: "arweave", key: arId }
  return { kind: "external", key: null }
}

/**
 * Map a cached probe result (cid_availability.retrievable: true/false/null) and
 * an attestation flag (token_pins) to an honest status. Probe verdict wins;
 * a self-attested pin is the fallback signal; otherwise unprobed.
 */
export function resolveArtworkStatus(
  retrievable: boolean | null,
  pinned: boolean,
): ArtworkPersistenceStatus {
  if (retrievable === true) return "retrievable"
  if (retrievable === false) return "unretrievable"
  if (pinned) return "artist-pinned"
  return "unprobed"
}
