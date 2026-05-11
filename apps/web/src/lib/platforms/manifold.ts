import "server-only"
import { createPublicClient, type Address } from "viem"
import { mainnet } from "viem/chains"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  CollectorTokenRef,
  AdapterLastSale,
} from "./types"
import { discoverManifoldTokenRefs } from "../manifold-discovery"
import { getAllNFTsForOwner } from "../alchemy"
import { mapWithConcurrency } from "../concurrency"
import {
  readManifoldCollectorTokens,
  writeManifoldCollectorTokens,
  readContractClassifications,
  writeContractClassifications,
  LAZY_TTL,
  isFresh,
} from "../lazy-index"
import { getMainnetTransport } from "../alchemy-transport"

// Marker interface for Manifold Creator Core (V1 + V2 share this).
const MANIFOLD_CC_INTERFACE_ID = "0x28f10a21" as const
const CLASSIFICATION_KIND = "manifold-cc"

const supportsInterfaceAbi = [
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: getMainnetTransport("manifold"),
  })
}

/**
 * Manifold platform adapter. Wraps `discoverManifoldTokenRefs` (which
 * already does its own lazy read/write through `lazy_manifold_artist_*`
 * tables). Manifold doesn't have on-chain marketplace events we index —
 * sales happen on Manifold's relay/Crossmint contracts that we don't
 * track yet — so `getLastSale` returns null. Callers fall back to
 * whatever other platform's marketplace surfaces a sale for the token.
 */
export const manifoldAdapter: PlatformAdapter = {
  id: "manifold",
  displayName: "Manifold",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    const refs = await discoverManifoldTokenRefs(artist)
    return refs.map((r) => ({
      platform: "manifold",
      contract: r.contract,
      tokenId: r.tokenId,
      blockNumber: null, // NFT API doesn't surface log context
      logIndex: null,
      collectionName: r.collectionName,
    }))
  },

  async discoverCollectorTokens(
    wallet: Address,
  ): Promise<CollectorTokenRef[]> {
    // Lazy read first.
    const cached = await readManifoldCollectorTokens(wallet)
    if (cached && isFresh(cached.lastIndexedAt, LAZY_TTL.manifoldCollectorTokens)) {
      return cached.tokens.map((t) => ({
        platform: "manifold",
        contract: t.contract as Address,
        tokenId: t.tokenId,
        ownerWallet: wallet,
        acquiredAtBlock: 0n,
        acquiredTxHash: null,
      }))
    }

    // Pull the wallet's full NFT inventory; bounded by 20-page cap so a
    // whale wallet doesn't run away with cost (~3K CU absolute ceiling).
    const allOwned = await getAllNFTsForOwner(wallet, 20)
    if (allOwned.length === 0) {
      writeManifoldCollectorTokens(wallet, [])
      return []
    }

    // Classify each unique contract: is it a Manifold creator core?
    // Read cached classifications first; only run supportsInterface on
    // the gaps. Future visits skip the on-chain check entirely.
    const uniqueContracts = [
      ...new Set(allOwned.map((o) => o.contract.toLowerCase())),
    ]
    const cachedClass = await readContractClassifications(
      uniqueContracts,
      CLASSIFICATION_KIND,
    )
    const unclassified = uniqueContracts.filter((c) => !cachedClass.has(c))

    if (unclassified.length > 0) {
      const client = getClient()
      // Bounded concurrency so a wallet with 200 unique contracts doesn't
      // fan out 200 simultaneous reads.
      const probes = await mapWithConcurrency(
        unclassified,
        8,
        async (contract) => {
          try {
            const isMatch = (await client.readContract({
              address: contract as Address,
              abi: supportsInterfaceAbi,
              functionName: "supportsInterface",
              args: [MANIFOLD_CC_INTERFACE_ID],
            })) as boolean
            return { contract, isMatch }
          } catch {
            // Reverts when the contract doesn't implement ERC-165 or
            // doesn't recognize the marker — both mean "not Manifold."
            return { contract, isMatch: false }
          }
        },
      )
      writeContractClassifications(
        probes.map((p) => ({
          contract: p.contract,
          kind: CLASSIFICATION_KIND,
          isMatch: p.isMatch,
        })),
      )
      for (const p of probes) cachedClass.set(p.contract, p.isMatch)
    }

    const refs: CollectorTokenRef[] = allOwned
      .filter((o) => cachedClass.get(o.contract.toLowerCase()) === true)
      .map((o) => ({
        platform: "manifold",
        contract: o.contract as Address,
        tokenId: o.tokenId,
        ownerWallet: wallet,
        acquiredAtBlock: 0n,
        acquiredTxHash: null,
      }))

    writeManifoldCollectorTokens(
      wallet,
      refs.map((r) => ({
        contract: r.contract,
        tokenId: r.tokenId,
        collectionName: null,
      })),
    )
    return refs
  },

  async getLastSale(): Promise<AdapterLastSale | null> {
    // No marketplace integration today.
    return null
  },
}
