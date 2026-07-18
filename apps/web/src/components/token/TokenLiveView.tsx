"use client"

/**
 * Live parity render for a single token page: the token's real onchain
 * seed run through the same document builder GenerativeRenderer.sol emits
 * (docs/injection-convention.md), byte-identical by construction — zero
 * heavy RPC. The 60-120M-gas tokenURI call stays reserved for TokenMedia's
 * Image mode (see collection-onchain.ts's getCollectionToken). Reuses the
 * render context wiring (resolver/gunzip caching) already established for
 * the collection page's live views rather than re-deriving it.
 */

import { useMemo } from "react"
import type { Address } from "viem"
import { TokenPreview, type TokenData, type WorkInput } from "@/lib/collection-render"
import { useRenderContext } from "@/components/collections/GenerativeViews"

export function TokenLiveView({
  work,
  seed,
  tokenId,
  collection,
  className,
  title,
}: {
  work: WorkInput
  /** The token's real onchain seed (tokenSeed). */
  seed: `0x${string}`
  tokenId: string
  collection: Address
  className?: string
  title?: string
}) {
  const { resolver, gunzip, chainId } = useRenderContext()

  const tokenData = useMemo<TokenData>(
    () => ({
      hash: seed,
      tokenId,
      collection: collection.toLowerCase(),
      chainId,
      version: work.injectionVersion,
      // A real minted token's seed: this is the canonical render.
      context: "token",
    }),
    [seed, tokenId, collection, chainId, work.injectionVersion],
  )

  if (!resolver) {
    return <div className={className ?? "aspect-square w-full bg-gray-100 dark:bg-bg"} />
  }

  return (
    <TokenPreview
      work={work}
      tokenData={tokenData}
      resolver={resolver}
      gunzip={gunzip}
      className={className}
      title={title}
    />
  )
}
