"use client"

// The drawn-punk reveal after a successful homage mint. The homage art is fully
// onchain: read tokenURI(punkId) off the collection, decode the data-URI JSON, and
// show its `image` (itself a data URI). No indexer, no gateway.

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
    // Some renderers return raw JSON with no data-uri prefix.
    return JSON.parse(uri)
  } catch {
    return null
  }
}

export function HomageReveal({
  collection,
  punkId,
  txHash,
  onDismiss,
}: {
  collection: Address
  punkId: bigint
  txHash: `0x${string}`
  onDismiss: () => void
}) {
  const {data: uri, isLoading} = useReadContract({
    address: collection,
    abi: homageCollectionAbi,
    functionName: "tokenURI",
    args: [punkId],
    chainId: PREFERRED_CHAIN.id,
    // Cold archive forks are slow for uncached punks; retry with backoff.
    query: {retry: 6, retryDelay: (i: number) => Math.min(800 * 2 ** i, 6000)},
  })

  const meta = useMemo(() => (typeof uri === "string" ? decodeDataUriJson(uri) : null), [uri])

  return (
    <div className="rounded-lg border border-gray-200 bg-surface-muted/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">Minted · Punk {punkId.toString()}</p>
        <button
          onClick={onDismiss}
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors"
        >
          Dismiss
        </button>
      </div>

      <div className="aspect-square w-full overflow-hidden rounded border border-gray-200 bg-surface">
        {meta?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={meta.image} alt={meta.name ?? `Homage to Punk ${punkId.toString()}`} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              {isLoading ? "Revealing…" : "Rendering onchain…"}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-mono text-fg">{meta?.name ?? `Homage to Punk ${punkId.toString()}`}</p>
        <div className="flex shrink-0 items-center gap-3">
          {/* The minted token's own page, the same destination each thumb in the batch
              reveal links to. */}
          <Link
            href={`/collections/${collection}/${punkId.toString()}`}
            className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
          >
            View token →
          </Link>
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
    </div>
  )
}
