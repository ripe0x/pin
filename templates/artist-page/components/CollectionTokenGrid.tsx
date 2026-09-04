/**
 * Recent-mints grid for the artist's optional Surface. Shows the
 * newest tokens (ids `1..min(minted, 12)`, newest first). Reads only begin
 * when an individual card enters the viewport; there is no polling.
 *
 * Sequential id-mode only — see `recentTokenIds` in lib/collection.ts for why
 * Pooled collections can't use this "ids are 1..minted" shortcut. Pooled
 * collections render no grid at all (see the guard in the caller) rather
 * than a misleading one.
 */
"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { Address } from "viem"
import { usePublicClient } from "wagmi"
import {
  createDirectChainSurfaceProvider,
  type CoreReleaseProvider,
  type ValidatedRelease,
} from "@pin/surface-kit"
import { useTokenState } from "@pin/surface-react"
import { recentTokenIds } from "@/lib/surface"
import { TokenMedia } from "./TokenMedia"
import { resolveTokenPreview, type TokenPreviewMetadata } from "@/lib/token-preview"

/** Heavy onchain tokenURI assembly must never fan out across the visible
 * row. Queue those reads while leaving validation, state, and mint calls on
 * the provider untouched. */
function serializeTokenReads(provider: CoreReleaseProvider): CoreReleaseProvider {
  let tail: Promise<void> = Promise.resolve()
  return {
    ...provider,
    readToken(input, signal) {
      const current = tail.then(() => {
        signal?.throwIfAborted()
        return provider.readToken(input, signal)
      })
      tail = current.then(() => undefined, () => undefined)
      return current
    },
  }
}

export function CollectionTokenGrid({
  collectionAddress,
  minted,
  owner,
  renderer,
  primaryMinter,
  validatedAtBlock,
}: {
  collectionAddress: Address
  minted: bigint
  owner: Address
  renderer: Address
  primaryMinter: Address | null
  validatedAtBlock: bigint
}) {
  const ids = recentTokenIds(minted, 12)
  const publicClient = usePublicClient({ chainId: 1 })
  const provider = useMemo(
    () => publicClient
      ? serializeTokenReads(createDirectChainSurfaceProvider({ client: publicClient }))
      : null,
    [publicClient],
  )
  const release = useMemo<ValidatedRelease>(() => ({
    chainId: 1,
    collection: collectionAddress,
    protocol: "surface@1",
    owner,
    renderer,
    idMode: 0,
    primaryMinter,
    validatedAtBlock,
  }), [collectionAddress, owner, primaryMinter, renderer, validatedAtBlock])
  if (ids.length === 0) return null

  return (
    <div>
      <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Recent mints
      </h2>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {ids.map((tokenId) => (
          <TokenCard key={`${collectionAddress}:${tokenId.toString()}`} provider={provider} release={release} tokenId={tokenId} />
        ))}
      </div>
    </div>
  )
}

function TokenCard({
  provider,
  release,
  tokenId,
}: {
  provider: ReturnType<typeof createDirectChainSurfaceProvider> | null
  release: ValidatedRelease
  tokenId: bigint
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [media, setMedia] = useState<TokenPreviewMetadata | null>(null)
  const [mediaFailed, setMediaFailed] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: "100px" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const token = useTokenState({
    provider,
    input: { release, tokenId },
    enabled: visible,
  })
  useEffect(() => {
    let cancelled = false
    setMedia(null)
    setMediaFailed(false)
    if (!token.value?.tokenUri) return
    void resolveTokenPreview(token.value.tokenUri).then((next) => {
      if (cancelled) return
      if (next) setMedia(next)
      else setMediaFailed(true)
    })
    return () => { cancelled = true }
  }, [token.value?.tokenUri])

  const title = `#${tokenId.toString()}`
  const state = !visible || token.phase === "loading" || (token.value?.tokenUri && !media && !mediaFailed)
    ? "loading"
    : token.phase === "blocked"
      ? "unavailable"
      : token.phase === "reduced" || (token.value && !token.value.tokenUri)
        ? "unavailable"
        : mediaFailed
          ? "failed"
        : media
          ? media.kind
          : "unavailable"
  return (
    <div ref={ref} className="group relative border border-gray-200 transition-colors hover:border-gray-400">
      <div className="aspect-square overflow-hidden bg-gray-100 flex items-center justify-center [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_video]:h-full [&_video]:w-full [&_video]:object-cover [&_iframe]:h-full [&_iframe]:w-full">
        {state === "image" || state === "video" || state === "html" ? (
          <TokenMedia image={media?.image ?? null} animationUrl={media?.animationUrl} title={title} />
        ) : (
          <div className="px-3 text-center">
            <span
              className="text-[11px] font-mono uppercase tracking-wider text-gray-400"
              title={token.message ?? undefined}
            >
              {state === "loading" ? "Loading preview…" : state === "failed" ? "Preview failed" : "Preview unavailable"}
            </span>
            {token.phase === "blocked" && token.retryable ? (
              <button
                type="button"
                onClick={() => void token.refresh()}
                className="mt-2 block w-full text-[10px] font-mono uppercase tracking-wider underline hover:text-fg"
              >
                Retry
              </button>
            ) : null}
          </div>
        )}
      </div>
      <div className="px-3 py-2.5 bg-surface-muted border-t border-gray-100">
        <p className="text-[11px] font-mono text-fg tracking-tight truncate leading-none">
          {title}
        </p>
      </div>
    </div>
  )
}
