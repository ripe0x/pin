import "server-only"
import { StandardMerkleTree } from "@openzeppelin/merkle-tree"
import { isAddress, type Address } from "viem"
import { sql } from "./db"

/**
 * Allowlist storage + proofs: the offchain half of a GateHook merkle gate.
 *
 * Trust model: storage is PERMISSIONLESS on purpose. A stored list grants
 * nothing by itself — proofs only verify against the root the collection's
 * owner/admin set onchain (GateHook.rootOf), and only they can set it. The
 * chain is the auth; this table is just where the mint page finds the
 * leaves for the active root. Publishing a list that never goes onchain is
 * inert, so the API needs no signature dance.
 *
 * Leaf format is the OZ standard-merkle-tree convention GateHook verifies:
 * keccak256(bytes.concat(keccak256(abi.encode(address)))) — produced here
 * by @openzeppelin/merkle-tree with the ["address"] leaf encoding.
 */

const MAX_ADDRESSES = 10_000

export type PublishResult =
  | { ok: true; root: `0x${string}`; count: number }
  | { ok: false; error: string }

/** Normalize, validate, dedupe, and sort a raw address list. Sorted so the
 *  same set of addresses always produces the same tree and root. */
export function normalizeAddresses(raw: string[]): { list: Address[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "No addresses provided." }
  if (raw.length > MAX_ADDRESSES) {
    return { error: `Too many addresses (max ${MAX_ADDRESSES}).` }
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

/** Build the tree for `raw`, store the list keyed by (collection, root),
 *  and return the root the artist must set onchain via GateHook.setRoot. */
export async function publishAllowlist(
  collection: Address,
  raw: string[],
): Promise<PublishResult> {
  if (!sql) return { ok: false, error: "Storage is not available." }
  const norm = normalizeAddresses(raw)
  if ("error" in norm) return { ok: false, error: norm.error }
  const tree = buildTree(norm.list)
  const root = tree.root as `0x${string}`
  const c = collection.toLowerCase()
  await sql`
    INSERT INTO collection_allowlists (collection, root, addresses, address_count)
    VALUES (${c}, ${root.toLowerCase()}, ${sql.json(norm.list)}, ${norm.list.length})
    ON CONFLICT (collection, root)
    DO UPDATE SET addresses = EXCLUDED.addresses,
                  address_count = EXCLUDED.address_count
  `
  return { ok: true, root, count: norm.list.length }
}

export type EligibilityResult =
  | { known: false } // no list stored for this root
  | { known: true; eligible: false }
  | { known: true; eligible: true; proof: `0x${string}`[] }

/** Look up the stored list for (collection, root) and compute `wallet`'s
 *  proof. Rebuilds the tree per call — fine at allowlist scale (a 10k-leaf
 *  tree builds in well under a second); cache by root if it ever shows up
 *  in a profile. */
export async function eligibilityFor(
  collection: Address,
  root: `0x${string}`,
  wallet: Address,
): Promise<EligibilityResult> {
  if (!sql) return { known: false }
  const rows = await sql<{ addresses: string[] }[]>`
    SELECT addresses FROM collection_allowlists
    WHERE collection = ${collection.toLowerCase()} AND root = ${root.toLowerCase()}
    LIMIT 1
  `
  if (rows.length === 0) return { known: false }
  const list = rows[0].addresses
  const w = wallet.toLowerCase()
  if (!list.includes(w)) return { known: true, eligible: false }
  const tree = buildTree(list as Address[])
  for (const [i, [leaf]] of tree.entries()) {
    if (leaf.toLowerCase() === w) {
      return { known: true, eligible: true, proof: tree.getProof(i) as `0x${string}`[] }
    }
  }
  return { known: true, eligible: false }
}

/** How many addresses the stored list for (collection, root) holds, or null
 *  when no list is published for that root. */
export async function allowlistCount(
  collection: Address,
  root: `0x${string}`,
): Promise<number | null> {
  if (!sql) return null
  const rows = await sql<{ address_count: number }[]>`
    SELECT address_count FROM collection_allowlists
    WHERE collection = ${collection.toLowerCase()} AND root = ${root.toLowerCase()}
    LIMIT 1
  `
  return rows.length > 0 ? rows[0].address_count : null
}
