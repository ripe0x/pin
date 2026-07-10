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
import { useMemo, useState } from "react"
import { keccak256, stringToBytes } from "viem"
import type { Address, PublicClient } from "viem"
import { useChainId, usePublicClient } from "wagmi"

import {
  TokenPreview,
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
    collection: collection.toLowerCase(),
    chainId,
    version,
    // A real minted token's seed: this is the canonical render.
    context: "token",
  }
}

/** Deterministic explore seed i for a collection: stable across visits,
 *  distinct per collection, clearly a throwaway (never a token's seed). */
function exploreSeed(collection: Address, i: number): `0x${string}` {
  return keccak256(stringToBytes(`${collection.toLowerCase()}:explore:${i}`))
}

export function GenerativeHero({
  collection,
  work,
  latest,
  minted,
}: {
  collection: Address
  work: WorkConfig
  /** The latest mint, or null pre-mint. */
  latest: RenderEntry | null
  /** Total minted, for "previewing the next token" numbering. */
  minted: string
}) {
  const { resolver, gunzip, chainId } = useRenderContext()
  // Pre-mint the hero can only explore; once minted, the latest real mint
  // leads and exploring is one quiet action away.
  const [exploring, setExploring] = useState(!latest)
  const [seedIndex, setSeedIndex] = useState(0)
  const explore = exploring || !latest

  const nextTokenId = String(BigInt(minted) + 1n)
  const tokenData = useMemo<TokenData>(() => {
    if (!explore && latest)
      return entryTokenData(latest, collection, chainId, work.injectionVersion)
    // Exploratory render: the real algorithm, a throwaway seed, framed as
    // the token the next mint WOULD be.
    return {
      hash: exploreSeed(collection, seedIndex),
      tokenId: nextTokenId,
      collection: collection.toLowerCase(),
      chainId,
      version: work.injectionVersion,
      context: "preview",
    }
  }, [explore, latest, seedIndex, nextTokenId, collection, chainId, work.injectionVersion])

  if (!resolver)
    return <div className="aspect-square w-full max-w-[min(80vh,860px)] bg-gray-100 dark:bg-bg" />

  return (
    <figure className="w-full max-w-[min(80vh,860px)]">
      <TokenPreview
        work={toWorkInput(work)}
        tokenData={tokenData}
        resolver={resolver}
        gunzip={gunzip}
        className="aspect-square w-full border border-gray-200 dark:border-gray-800"
        title={explore ? "preview render" : `token ${latest?.tokenId} live render`}
      />
      <figcaption className="mt-2 flex items-baseline justify-between gap-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        <span>
          {explore
            ? latest
              ? "Example output · your mint will differ"
              : "Example output · no tokens minted yet · your mint will differ"
            : `Token #${latest?.tokenId} · live render from its onchain seed`}
        </span>
        <span className="flex shrink-0 items-baseline gap-3">
          {explore && (
            <button
              type="button"
              onClick={() => setSeedIndex((i) => i + 1)}
              className="underline decoration-gray-300 underline-offset-2 hover:text-fg transition-colors"
            >
              New seed ↻
            </button>
          )}
          {latest && (
            <button
              type="button"
              onClick={() => setExploring((e) => !e)}
              className="underline decoration-gray-300 underline-offset-2 hover:text-fg transition-colors"
            >
              {explore ? "Latest mint" : "Explore outputs"}
            </button>
          )}
        </span>
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
