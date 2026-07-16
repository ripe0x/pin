// Allowlist Merkle proofs for the homage window-2 mint. The tree + root are built
// offline (homage repo scripts/build-allowlist.mjs) and the proof file is vendored
// BYTE-IDENTICAL from the homage repo's data/allowlist-proofs.json — the two
// frontends must verify against the same on-chain root, so re-vendor on any change.
import proofsData from "@/data/homage-allowlist-proofs.json"

type ProofFile = {root: `0x${string}`; count: number; proofs: Record<string, `0x${string}`[]>}
const data = proofsData as ProofFile

export const ALLOWLIST_ROOT = data.root
export const ALLOWLIST_COUNT = data.count

/** The Merkle proof for `address`, or null if it isn't on the allowlist (case-insensitive). */
export function allowlistProofFor(address: string): `0x${string}`[] | null {
  return data.proofs[address.toLowerCase()] ?? null
}
