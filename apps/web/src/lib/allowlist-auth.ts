/**
 * Signed publish requests for collection allowlists.
 *
 * Publishing stores a list (up to 10k addresses) under a collection, so only
 * the collection's owner or an admin may do it. The client signs an EIP-191
 * personal message binding the chain, the collection, the merkle root of
 * the exact list being posted, and an issue time; the server rebuilds that
 * message from its own view of the request (it recomputes the root from the
 * posted addresses), checks the signature, the freshness window, and that
 * the signer is authorized on the collection.
 *
 * Pure, with the signature check and the authorization lookup injected, so
 * it is shared by the client (message text) and the server (verification)
 * and is testable without a chain.
 */
import { isAddress, isHex } from "viem"

/** How long a signed publish request stays valid. */
export const ALLOWLIST_SIGNATURE_TTL_MS = 10 * 60_000
/** Tolerated clock skew for an issue time slightly in the future. */
export const ALLOWLIST_SIGNATURE_SKEW_MS = 2 * 60_000

export function buildAllowlistPublishMessage(p: {
  chainId: number
  collection: string
  root: string
  issuedAt: string
}): string {
  return [
    "PND allowlist publish",
    "",
    `Chain ID: ${p.chainId}`,
    `Collection: ${p.collection.toLowerCase()}`,
    `Merkle root: ${p.root.toLowerCase()}`,
    `Issued at: ${p.issuedAt}`,
  ].join("\n")
}

export type AllowlistAuthInput = {
  collection: string
  /** Root the server computed from the posted addresses. */
  root: `0x${string}`
  chainId: unknown
  issuedAt: unknown
  signer: unknown
  signature: unknown
}

export type AllowlistAuthDeps = {
  expectedChainId: number
  now: number
  verify(args: { address: `0x${string}`; message: string; signature: `0x${string}` }): Promise<boolean>
  /** Owner or admin of `collection`. */
  isAuthorized(collection: `0x${string}`, signer: `0x${string}`): Promise<boolean>
}

export type AllowlistAuthResult =
  | { ok: true; signer: `0x${string}` }
  | { ok: false; status: 400 | 401 | 403; error: string }

export async function verifyAllowlistPublish(
  input: AllowlistAuthInput,
  deps: AllowlistAuthDeps,
): Promise<AllowlistAuthResult> {
  const { collection, root, chainId, issuedAt, signer, signature } = input
  if (typeof signer !== "string" || !isAddress(signer)) {
    return { ok: false, status: 400, error: "A signer address is required." }
  }
  if (typeof signature !== "string" || !isHex(signature)) {
    return { ok: false, status: 400, error: "A signature is required." }
  }
  if (typeof issuedAt !== "string") {
    return { ok: false, status: 400, error: "An issue time is required." }
  }
  if (chainId !== deps.expectedChainId) {
    return { ok: false, status: 401, error: "Signed for a different chain." }
  }
  const issued = Date.parse(issuedAt)
  if (!Number.isFinite(issued)) {
    return { ok: false, status: 400, error: "Bad issue time." }
  }
  if (deps.now - issued > ALLOWLIST_SIGNATURE_TTL_MS || issued - deps.now > ALLOWLIST_SIGNATURE_SKEW_MS) {
    return { ok: false, status: 401, error: "Signature expired. Sign again." }
  }
  if (!isAddress(collection)) {
    return { ok: false, status: 400, error: "Bad collection address." }
  }

  const message = buildAllowlistPublishMessage({ chainId: deps.expectedChainId, collection, root, issuedAt })
  const valid = await deps
    .verify({ address: signer as `0x${string}`, message, signature: signature as `0x${string}` })
    .catch(() => false)
  if (!valid) return { ok: false, status: 401, error: "Signature does not match." }

  const authorized = await deps
    .isAuthorized(collection as `0x${string}`, signer as `0x${string}`)
    .catch(() => false)
  if (!authorized) {
    return { ok: false, status: 403, error: "Only the collection owner or an admin can publish a list." }
  }
  return { ok: true, signer: signer as `0x${string}` }
}
