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
 * their token pages. Accepts an optional `live` refresh mode (§8.1): while
 * Open and the tab is visible, it re-pulls the server prop on an interval
 * via router.refresh() rather than opening any new client-side RPC read.
 *
 * ExploreGrid: a small gallery of deterministic sample outputs (§4 [S]) —
 * distinct throwaway seeds (offset well clear of the hero's reroll
 * sequence) so a Scheduled page shows range at a glance. Cells are not
 * tokens and link nowhere.
 */

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
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

// The hero's reroll walks exploreSeed indices 0, 1, 2, … on every click; the
// preview grid starts well past any plausible click count so its samples
// never coincide with a seed a visitor already rerolled to in the hero.
const EXPLORE_GRID_INDEX_OFFSET = 1000

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

const LIVE_REFRESH_INTERVAL_MS = 30_000

export function RecentMintsGrid({
  collection,
  work,
  entries,
  /** While true (Open + tab visible), re-pull the server prop on an
   *  interval so watchers see the collection grow. No client RPC: this
   *  just calls router.refresh() to re-run the server component. */
  live = false,
}: {
  collection: Address
  work: WorkConfig
  entries: RenderEntry[]
  live?: boolean
}) {
  const { resolver, gunzip, chainId } = useRenderContext()
  const router = useRouter()

  // Track which tokenIds are new since the last render so only they get the
  // entrance treatment; the grid's own first mount never animates.
  const seenIds = useRef<Set<string>>(new Set(entries.map((e) => e.tokenId)))
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    const seen = seenIds.current
    const fresh = new Set(entries.filter((e) => !seen.has(e.tokenId)).map((e) => e.tokenId))
    seenIds.current = new Set(entries.map((e) => e.tokenId))
    if (fresh.size > 0) setFreshIds(fresh)
  }, [entries])

  // Zero timers unless live and the tab is actually visible; the listener
  // starts/stops the interval on visibilitychange rather than polling in
  // the background.
  useEffect(() => {
    if (!live) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer !== null) return
      timer = setInterval(() => {
        if (document.visibilityState === "visible") router.refresh()
      }, LIVE_REFRESH_INTERVAL_MS)
    }
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") start()
      else stop()
    }
    if (document.visibilityState === "visible") start()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [live, router])

  if (!resolver || entries.length === 0) return null

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {entries.map((e) => (
        <Link
          key={e.tokenId}
          href={`/collections/${collection.toLowerCase()}/${e.tokenId}`}
          className={`group block ${freshIds.has(e.tokenId) ? "animate-reveal" : ""}`}
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

export function ExploreGrid({
  collection,
  work,
  count = 6,
}: {
  collection: Address
  work: WorkConfig
  /** Number of sample outputs to render. Default 6. */
  count?: number
}) {
  const { resolver, gunzip, chainId } = useRenderContext()
  const samples = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        seed: exploreSeed(collection, EXPLORE_GRID_INDEX_OFFSET + i),
      })),
    [collection, count],
  )

  if (!resolver) return null

  return (
    <div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {samples.map((s) => (
          <div key={s.index} className="block">
            <TokenPreview
              work={toWorkInput(work)}
              tokenData={{
                hash: s.seed,
                tokenId: String(s.index + 1),
                collection: collection.toLowerCase(),
                chainId,
                version: work.injectionVersion,
                context: "preview",
              }}
              resolver={resolver}
              gunzip={gunzip}
              className="aspect-square w-full border border-gray-200 dark:border-gray-800 pointer-events-none"
              title={`example output ${s.index + 1}`}
            />
            <span className="mt-1 block text-[10px] font-mono text-gray-400">
              Example {String(s.index + 1).padStart(2, "0")}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10px] font-mono text-gray-400 normal-case leading-relaxed">
        Example outputs. Every mint is generated from its own transaction.
      </p>
    </div>
  )
}
