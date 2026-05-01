"use client"

import { useEffect, useState } from "react"
import { useReadContract } from "wagmi"
import { erc721Abi } from "@pin/abi"
import { ipfsToHttp } from "@pin/shared"

type Metadata = {
  name?: string
  image?: string
}

/**
 * Renders a small preview of an ERC-721 token: image + name pulled from
 * tokenURI metadata, plus a live ownership check against `expectedOwner`.
 * Calls `onOwnedChange` when the ownership state resolves so the parent can
 * decide whether to reveal the auction-terms form.
 *
 * Treats the (contract, tokenId) pair as user input — bad/invalid pairs surface
 * as "Couldn't load this token" rather than crashing the page.
 */
export function TokenPreview({
  nftContract,
  tokenId,
  expectedOwner,
  onOwnedChange,
}: {
  nftContract: `0x${string}`
  tokenId: string
  expectedOwner: `0x${string}` | undefined
  onOwnedChange: (owned: boolean) => void
}) {
  const {
    data: tokenUri,
    isLoading: uriLoading,
    error: uriError,
  } = useReadContract({
    address: nftContract,
    abi: erc721Abi,
    functionName: "tokenURI",
    args: [BigInt(tokenId)],
  })

  const {
    data: currentOwner,
    isLoading: ownerLoading,
    error: ownerError,
  } = useReadContract({
    address: nftContract,
    abi: erc721Abi,
    functionName: "ownerOf",
    args: [BigInt(tokenId)],
  })

  const [meta, setMeta] = useState<Metadata | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)

  useEffect(() => {
    if (!tokenUri || typeof tokenUri !== "string") return
    let cancelled = false
    const url = ipfsToHttp(tokenUri)
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((json: Metadata) => {
        if (!cancelled) setMeta(json)
      })
      .catch((e) => {
        if (!cancelled) setMetaError(String(e?.message ?? e))
      })
    return () => {
      cancelled = true
    }
  }, [tokenUri])

  const owned =
    !!expectedOwner &&
    !!currentOwner &&
    expectedOwner.toLowerCase() === (currentOwner as string).toLowerCase()

  useEffect(() => {
    onOwnedChange(owned)
  }, [owned, onOwnedChange])

  const loading = uriLoading || ownerLoading
  const readError = uriError || ownerError
  const imageUrl = meta?.image ? ipfsToHttp(meta.image) : null
  const name = meta?.name ?? `#${tokenId}`

  if (readError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4">
        <p className="text-sm font-medium text-red-700">
          Couldn&apos;t load this token
        </p>
        <p className="text-xs text-red-700/80 mt-1">
          Check the contract address and token ID are correct, and that this is
          an ERC-721 collection.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded border border-gray-200 bg-surface p-4 flex gap-4 items-start">
      <div className="w-24 h-24 flex-shrink-0 bg-gray-100 rounded overflow-hidden">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
            {loading || (!meta && !metaError) ? "…" : "No image"}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-sm font-medium truncate">{name}</p>
        <p className="text-xs text-gray-500 truncate">
          {nftContract.slice(0, 6)}…{nftContract.slice(-4)} · #{tokenId}
        </p>
        {ownerLoading ? (
          <p className="text-xs text-gray-400 mt-2">Checking ownership…</p>
        ) : owned ? (
          <p className="text-xs text-emerald-700 mt-2">You own this ✓</p>
        ) : currentOwner ? (
          <p className="text-xs text-amber-700 mt-2 break-all">
            Owned by {(currentOwner as string).slice(0, 6)}…
            {(currentOwner as string).slice(-4)} — you can&apos;t list a token
            you don&apos;t own.
          </p>
        ) : null}
        {metaError && !imageUrl && (
          <p className="text-xs text-gray-400 mt-1">
            Couldn&apos;t fetch metadata, but ownership is what matters.
          </p>
        )}
      </div>
    </div>
  )
}
