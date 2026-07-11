"use client"

/**
 * Shared render plumbing for generative collection views, built on the
 * parity library: dependency bytes are fetched once through
 * cachedChainResolver and shared by every iframe on the page, and the
 * 60-120M-gas tokenURI call is never made here (that read is reserved for
 * token pages).
 *
 * These helpers back CollectionMosaic (the collection hero) and the mint
 * reveal. The seed conventions are load-bearing: `entryTokenData` marks a
 * real mint's render `context: "token"`, and `exploreSeed` produces the
 * throwaway example seeds every explore surface walks (each surface uses a
 * distinct index offset so their samples never collide).
 */

import { useMemo } from "react"
import { keccak256, stringToBytes } from "viem"
import type { Address, PublicClient } from "viem"
import { useChainId, usePublicClient } from "wagmi"

import {
  cachedChainResolver,
  defaultGunzip,
  type TokenData,
  type WorkInput,
} from "@/lib/collection-render"
import type { WorkConfig } from "@/lib/collection"

export type RenderEntry = {
  tokenId: string
  seed: `0x${string}`
}

export function useRenderContext() {
  const client = usePublicClient()
  const chainId = useChainId()
  const resolver = useMemo(
    () => (client ? cachedChainResolver(client as unknown as PublicClient) : null),
    [client],
  )
  const gunzip = useMemo(() => defaultGunzip(chainId), [chainId])
  return { resolver, gunzip, chainId }
}

export function toWorkInput(work: WorkConfig): WorkInput {
  return { code: work.code, deps: work.deps, injectionVersion: work.injectionVersion }
}

export function entryTokenData(
  entry: RenderEntry,
  collection: Address,
  chainId: number,
  version: number,
): TokenData {
  return {
    hash: entry.seed,
    tokenId: entry.tokenId,
    collection: collection.toLowerCase(),
    chainId,
    version,
    // A real minted token's seed: this is the canonical render.
    context: "token",
  }
}

/** Deterministic explore seed i for a collection: stable across visits,
 *  distinct per collection, clearly a throwaway (never a token's seed).
 *  Each explore surface offsets its index range so samples never collide:
 *  the mosaic's parity examples start at 3000, its onchain reroll walks the
 *  onchain previewURI seed indices, and the reveal never uses these. */
export function exploreSeed(collection: Address, i: number): `0x${string}` {
  return keccak256(stringToBytes(`${collection.toLowerCase()}:explore:${i}`))
}
