"use client"

/**
 * Client-side live renders for generative collections, built on the parity
 * library: tokenSeed reads are one slot each, the dependency bytes are
 * fetched once through cachedChainResolver and shared by every iframe on
 * the page, and the 60-120M-gas tokenURI call is never made here (that read
 * is reserved for token pages).
 *
 * GenerativeHero: the collection page's main visual when the artist set no
 * cover. Shows the latest mint's REAL seed when anything is minted, else a
 * deterministic preview seed derived from the collection address (stable
 * across visits, labeled as a preview) so a drop page is alive before the
 * first mint.
 *
 * RecentMintsGrid: latest mints rendered from their real seeds, linking to
 * their token pages.
 */

import Link from "next/link"
import { useMemo } from "react"
import { keccak256 } from "viem"
import type { Address, PublicClient } from "viem"
import { useChainId, usePublicClient } from "wagmi"

import {
  TokenPreview,
  cachedChainResolver,
  defaultGunzip,
  type TokenData,
  type WorkInput,
} from "@/lib/collection-render"
import type { WorkConfig } from "@/lib/sovereign-collection"

export type RenderEntry = {
  tokenId: string
  seed: `0x${string}`
  mintIndex: number
  mintBlock: number
}

function useRenderContext() {
  const client = usePublicClient()
  const chainId = useChainId()
  const resolver = useMemo(
    () => (client ? cachedChainResolver(client as unknown as PublicClient) : null),
    [client],
  )
  const gunzip = useMemo(() => defaultGunzip(chainId), [chainId])
  return { resolver, gunzip, chainId }
}

function toWorkInput(work: WorkConfig): WorkInput {
  return { code: work.code, deps: work.deps, injectionVersion: work.injectionVersion }
}

function entryTokenData(
  entry: RenderEntry,
  collection: Address,
  chainId: number,
  version: number,
): TokenData {
  return {
    hash: entry.seed,
    tokenId: entry.tokenId,
    mintIndex: entry.mintIndex,
    mintBlock: entry.mintBlock,
    collection: collection.toLowerCase(),
    chainId,
    version,
  }
}

export function GenerativeHero({
  collection,
  work,
  latest,
}: {
  collection: Address
  work: WorkConfig
  /** The latest mint, or null pre-mint. */
  latest: RenderEntry | null
}) {
  const { resolver, gunzip, chainId } = useRenderContext()

  const tokenData = useMemo<TokenData>(() => {
    if (latest) return entryTokenData(latest, collection, chainId, work.injectionVersion)
    // Deterministic pre-mint preview: stable across visits, clearly labeled.
    return {
      hash: keccak256(collection),
      tokenId: "1",
      mintIndex: 0,
      mintBlock: 0,
      collection: collection.toLowerCase(),
      chainId,
      version: work.injectionVersion,
    }
  }, [latest, collection, chainId, work.injectionVersion])

  if (!resolver) return <div className="aspect-square w-full max-w-[640px] bg-gray-100 dark:bg-bg" />

  return (
    <figure className="w-full max-w-[640px]">
      <TokenPreview
        work={toWorkInput(work)}
        tokenData={tokenData}
        resolver={resolver}
        gunzip={gunzip}
        className="aspect-square w-full border border-gray-200 dark:border-gray-800"
        title={latest ? `token ${latest.tokenId} live render` : "preview render"}
      />
      <figcaption className="mt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        {latest
          ? `Token #${latest.tokenId} · live render from its onchain seed`
          : "Preview render · deterministic seed, no tokens minted yet"}
      </figcaption>
    </figure>
  )
}

export function RecentMintsGrid({
  collection,
  work,
  entries,
}: {
  collection: Address
  work: WorkConfig
  entries: RenderEntry[]
}) {
  const { resolver, gunzip, chainId } = useRenderContext()
  if (!resolver || entries.length === 0) return null

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {entries.map((e) => (
        <Link
          key={e.tokenId}
          href={`/collections/${collection.toLowerCase()}/${e.tokenId}`}
          className="group block"
        >
          <TokenPreview
            work={toWorkInput(work)}
            tokenData={entryTokenData(e, collection, chainId, work.injectionVersion)}
            resolver={resolver}
            gunzip={gunzip}
            className="aspect-square w-full border border-gray-200 dark:border-gray-800 pointer-events-none"
            title={`token ${e.tokenId}`}
          />
          <span className="mt-1 block text-[10px] font-mono text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300">
            #{e.tokenId}
          </span>
        </Link>
      ))}
    </div>
  )
}
