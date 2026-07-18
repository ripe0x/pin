"use client"

/**
 * The reveal: the emotional payoff of a generative mint. After the receipt
 * lands, this reads the fresh token seeds (one multicall — the only
 * unavoidable post-mint read, seeds are prevrandao-derived and cannot be
 * precomputed) and renders the collector's actual piece(s) live via the
 * parity builder, numbered, seconds after confirmation. No indexer round
 * trip, no delayed reveal: the seed exists, so the artwork exists.
 *
 * For collections without a generative work (edition presets), there is no
 * live render to show; the reveal is the numbered Mint Mark plus the link.
 */

import Link from "next/link"
import { useMemo } from "react"
import { useReadContracts } from "wagmi"
import { surfaceAbi } from "@pin/abi"
import { evmNowTxUrl } from "@/lib/collection"
import type { WorkConfig } from "@/lib/collection"
import { TokenPreview, type TokenData } from "@/lib/collection-render"
import { useRenderContext } from "./GenerativeViews"

// Cap the live reveal grid: beyond this many tokens, render only the first
// N live and hand off the rest to the collection page instead of mounting
// N iframes (each a real render cost) for a large batch mint.
const MAX_REVEAL_CELLS = 4

export function MintReveal({
  collection,
  work,
  firstTokenId,
  quantity,
  txHash,
  chainId,
  onDismiss,
}: {
  collection: `0x${string}`
  /** The collection's work config, or null for non-generative collections. */
  work: WorkConfig | null
  firstTokenId: bigint
  quantity: bigint
  txHash: `0x${string}`
  chainId: number
  onDismiss: () => void
}) {
  const ids = useMemo(
    () =>
      Array.from({ length: Number(quantity) }, (_, i) => firstTokenId + BigInt(i)),
    [firstTokenId, quantity],
  )

  const visibleIds = ids.slice(0, MAX_REVEAL_CELLS)
  const hiddenCount = ids.length - visibleIds.length

  const { data: seedReads, refetch: refetchSeeds } = useReadContracts({
    contracts: visibleIds.map((id) => ({
      address: collection,
      abi: surfaceAbi,
      functionName: "tokenSeed" as const,
      args: [id] as const,
    })),
    query: { staleTime: Infinity }, // a seed never changes
  })

  const seeds = seedReads?.map((r) => (r.status === "success" ? (r.result as `0x${string}`) : null))
  const seedErrored = seedReads?.map((r) => r.status === "failure")

  const headline =
    ids.length === 1
      ? `You minted #${ids[0]}`
      : `You minted #${ids[0]} to #${ids[ids.length - 1]}`

  return (
    <div className="space-y-4 animate-reveal">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm font-mono font-medium tracking-tight">{headline}</p>
        <a
          href={evmNowTxUrl(txHash, chainId)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg shrink-0"
        >
          Tx ↗
        </a>
      </div>

      {work ? (
        <div className={ids.length === 1 ? "" : "grid grid-cols-2 gap-3"}>
          {visibleIds.map((id, i) => (
            <Link
              key={id.toString()}
              href={`/collections/${collection.toLowerCase()}/${id}`}
              className="group block"
            >
              <RevealCell
                collection={collection}
                work={work}
                tokenId={id.toString()}
                seed={seeds?.[i] ?? null}
                hasError={seedErrored?.[i] ?? false}
                onRetry={() => void refetchSeeds()}
              />
              <span className="mt-1 block text-[10px] font-mono text-gray-400 group-hover:text-fg transition-colors">
                #{id.toString()} · view token →
              </span>
            </Link>
          ))}
          {hiddenCount > 0 && (
            <Link
              href={`/collections/${collection.toLowerCase()}`}
              className="group flex aspect-square w-full flex-col items-center justify-center gap-1 border border-dashed border-gray-200 dark:border-gray-800 text-center"
            >
              <span className="text-sm font-mono text-gray-500 group-hover:text-fg transition-colors">
                +{hiddenCount} more
              </span>
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 group-hover:text-fg transition-colors">
                view the collection →
              </span>
            </Link>
          )}
        </div>
      ) : (
        <p className="text-[11px] font-mono text-gray-600 leading-relaxed">
          {ids.length === 1
            ? `Token #${ids[0]} is yours. Its Mint Mark is recorded onchain.`
            : `Tokens #${ids[0]} to #${ids[ids.length - 1]} are yours. Their Mint Marks are recorded onchain.`}{" "}
          <Link
            href={`/collections/${collection.toLowerCase()}/${ids[0]}`}
            className="underline hover:text-fg"
          >
            View token →
          </Link>
        </p>
      )}

      <button
        type="button"
        onClick={onDismiss}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 border border-gray-200 hover:border-gray-400 transition-colors"
      >
        Mint another
      </button>
    </div>
  )
}

function RevealCell({
  collection,
  work,
  tokenId,
  seed,
  hasError,
  onRetry,
}: {
  collection: `0x${string}`
  work: WorkConfig
  tokenId: string
  seed: `0x${string}` | null
  /** True when the tokenSeed read for this token errored (vs. still pending). */
  hasError?: boolean
  /** Re-fires the seed reads (wagmi's useReadContracts refetch). */
  onRetry?: () => void
}) {
  const { resolver, gunzip, chainId } = useRenderContext()

  const tokenData = useMemo<TokenData | null>(() => {
    if (!seed) return null
    return {
      hash: seed,
      tokenId,
      collection: collection.toLowerCase(),
      chainId,
      version: work.injectionVersion,
      // The seed is real and stored: this IS the canonical render.
      context: "token",
    }
  }, [seed, tokenId, collection, chainId, work.injectionVersion])

  if (!tokenData || !resolver) {
    return (
      <div className="aspect-square w-full border border-gray-200 dark:border-gray-800">
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-gray-100 dark:bg-gray-900">
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Rendering…
          </span>
          {hasError && onRetry && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onRetry()
              }}
              className="text-[10px] font-mono uppercase tracking-wider text-gray-500 underline hover:text-fg"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <TokenPreview
      work={{ code: work.code, deps: work.deps, injectionVersion: work.injectionVersion }}
      tokenData={tokenData}
      resolver={resolver}
      gunzip={gunzip}
      className="aspect-square w-full border border-gray-200 dark:border-gray-800 pointer-events-none"
      title={`token ${tokenId} live render`}
    />
  )
}
