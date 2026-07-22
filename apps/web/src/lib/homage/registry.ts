// Homage registry — which collection(s) PND hosts the bespoke homage mint UI for.
//
// Homage is a POOLED Surface driven by a bespoke `HomageMinter` extension. The
// pooled core stores minters in a `mapping(address => bool)` with only an
// `isMinter(addr)` probe — there is no "who is the minter" getter — so PND can't
// cheaply discover the minter from the collection alone. Homage is also a specific,
// curated collection (not "any collection that looks homage-ish"), so a small
// registry keyed by the known collection address is the right shape: it works in
// dev and prod with no indexer changes and no log scans.
//
//   - Fork/dev: the local harness (scripts/dev-collections.sh) deploys homage at a
//     fresh address each run and writes NEXT_PUBLIC_HOMAGE_{COLLECTION,MINTER} into
//     apps/web/.env.development.local, which we read here.
//   - Mainnet: the canonical deployed pair, hardcoded once homage ships.
//
// `detect.ts` verifies the pair on-chain (minter.collection() === collection) before
// trusting it, so a stale/misconfigured env can only fail closed, never mint wrong.

import {type Address, getAddress, isAddress} from "viem"
import {mainnet, sepolia} from "viem/chains"

// Local FORK_MODE check (mirrors collection-onchain.ts) so this module stays
// server-safe — it must not pull in the client-only wagmi config.
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Opt-in sepolia instance (mirrors mint-collections.ts' MINT_CHAIN_ID split).
const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"

export type HomagePair = {collection: Address; minter: Address}

/** Canonical mainnet homage. Null until homage ships on mainnet. */
const MAINNET_HOMAGE: HomagePair | null = null
// e.g. once live:
// { collection: "0x…", minter: "0x…" }

function forkHomage(): HomagePair | null {
  const collection = process.env.NEXT_PUBLIC_HOMAGE_COLLECTION
  const minter = process.env.NEXT_PUBLIC_HOMAGE_MINTER
  if (!collection || !minter || !isAddress(collection) || !isAddress(minter)) return null
  return {collection: getAddress(collection), minter: getAddress(minter)}
}

// Sepolia pair reuses the same env vars mint-modules/homage.ts reads
// (NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS / _MINTER_ADDRESS) — one address pair
// per running instance, so fork/sepolia/mainnet never need to coexist.
function sepoliaHomage(): HomagePair | null {
  const collection = process.env.NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS
  const minter = process.env.NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS
  if (!collection || !minter || !isAddress(collection) || !isAddress(minter)) return null
  return {collection: getAddress(collection), minter: getAddress(minter)}
}

function pairsFor(chainId: number): HomagePair[] {
  const out: HomagePair[] = []
  if (FORK_MODE) {
    const f = forkHomage()
    if (f) out.push(f)
  } else if (USE_SEPOLIA && chainId === sepolia.id) {
    const s = sepoliaHomage()
    if (s) out.push(s)
  } else if (chainId === mainnet.id && MAINNET_HOMAGE) {
    out.push(MAINNET_HOMAGE)
  }
  return out
}

/**
 * The HomageMinter address for `collection` on `chainId`, or null if `collection`
 * is not a registered homage collection. Case-insensitive on the collection address.
 */
export function homageMinterFor(collection: Address, chainId: number): Address | null {
  const lc = collection.toLowerCase()
  for (const p of pairsFor(chainId)) {
    if (p.collection.toLowerCase() === lc) return p.minter
  }
  return null
}
