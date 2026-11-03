/**
 * Allowlist normalization and merkle tree, shared by the server (which stores
 * the list and serves proofs) and the studio client (which needs the root to
 * sign the publish request before posting it). No I/O.
 *
 * Leaf format is the OZ standard-merkle-tree convention the minter verifies:
 * keccak256(bytes.concat(keccak256(abi.encode(address)))) — produced here
 * by @openzeppelin/merkle-tree with the ["address"] leaf encoding.
 */
import { StandardMerkleTree } from "@openzeppelin/merkle-tree"
import { isAddress, type Address } from "viem"

export const MAX_ALLOWLIST_ADDRESSES = 10_000

/** Normalize, validate, dedupe, and sort a raw address list. Sorted so the
 *  same set of addresses always produces the same tree and root. */
export function normalizeAddresses(raw: string[]): { list: Address[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "No addresses provided." }
  if (raw.length > MAX_ALLOWLIST_ADDRESSES) {
    return { error: `Too many addresses (max ${MAX_ALLOWLIST_ADDRESSES}).` }
  }
  const seen = new Set<string>()
  for (const a of raw) {
    if (typeof a !== "string" || !isAddress(a.trim())) {
      return { error: `Not an address: ${String(a).slice(0, 64)}` }
    }
    seen.add(a.trim().toLowerCase())
  }
  return { list: [...seen].sort() as Address[] }
}

export function buildTree(list: Address[]) {
  return StandardMerkleTree.of(
    list.map((a) => [a]),
    ["address"],
  )
}

/** The root `raw` would publish under, or the normalization error. */
export function allowlistRoot(raw: string[]): { root: `0x${string}`; list: Address[] } | { error: string } {
  const norm = normalizeAddresses(raw)
  if ("error" in norm) return norm
  return { root: buildTree(norm.list).root as `0x${string}`, list: norm.list }
}
