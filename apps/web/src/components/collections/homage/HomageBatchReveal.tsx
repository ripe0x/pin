"use client"

// Batch success state: after a mintBatch, the drawn homages are revealed as a compact
// grid of thumbnails (each labeled #id, linking to its detail page) rather than a single
// big reveal. Each cell reads the token's own onchain tokenURI (like HomageReveal).

import {useMemo} from "react"
import Link from "next/link"
import {type Address} from "viem"
import {useReadContract} from "wagmi"
import {PREFERRED_CHAIN, evmNowTxUrl} from "@/components/tx/tx-ui"
import {homageCollectionAbi} from "@/lib/homage/contracts"

function decodeDataUriJson(uri: string): {name?: string; image?: string} | null {
  try {
    if (uri.startsWith("data:application/json;base64,")) {
      const b64 = uri.slice("data:application/json;base64,".length)
      const json = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8")
      return JSON.parse(json)
    }
    const comma = uri.indexOf(",")
    if (uri.startsWith("data:application/json") && comma !== -1) {
      return JSON.parse(decodeURIComponent(uri.slice(comma + 1)))
    }
    return JSON.parse(uri)
  } catch {
    return null
  }
}

function Thumb({collection, id}: {collection: Address; id: bigint}) {
  const {data} = useReadContract({
    address: collection,
    abi: homageCollectionAbi,
    functionName: "tokenURI",
    args: [id],
    chainId: PREFERRED_CHAIN.id,
    query: {staleTime: 60_000, retry: 6, retryDelay: (i: number) => Math.min(800 * 2 ** i, 6000)},
  })
  const meta = typeof data === "string" ? decodeDataUriJson(data) : null
  return (
    <Link
      href={`/collections/${collection}/${id}`}
      className="group block outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <div className="relative aspect-square overflow-hidden rounded border border-gray-200 bg-surface">
        {meta?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={meta.image} alt={`Homage to Punk #${id.toString()}`} className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full animate-pulse bg-gray-100 dark:bg-bg" />
        )}
        <span className="absolute bottom-1 left-1 font-mono text-[9px] uppercase tracking-wider text-white/70 mix-blend-difference">
          #{id.toString()}
        </span>
      </div>
    </Link>
  )
}

export function HomageBatchReveal({
  collection,
  punkIds,
  txHash,
  onDismiss,
}: {
  collection: Address
  punkIds: bigint[]
  txHash: `0x${string}`
  onDismiss: () => void
}) {
  const ids = useMemo(() => punkIds.slice(), [punkIds])
  return (
    <div className="rounded-lg border border-gray-200 bg-surface-muted/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">You minted {ids.length} homages</p>
        <button
          onClick={onDismiss}
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors"
        >
          Dismiss
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {ids.map((id) => (
          <Thumb key={id.toString()} collection={collection} id={id} />
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Tap any to open it</span>
        <a
          href={evmNowTxUrl(txHash, PREFERRED_CHAIN.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
        >
          View tx ↗
        </a>
      </div>
    </div>
  )
}
