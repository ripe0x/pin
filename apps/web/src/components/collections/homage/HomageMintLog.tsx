"use client"

// Proof that mints ARE reconstructable from onchain data: scans recent
// Transfer(from=0x0) events straight off the collection contract and renders
// them as a mint feed (thumbnail + "Homage to Punk <id>" + minter identity),
// mirroring the row shape of the homepage activity feed
// (components/home/v2/ActivityRow.tsx) — thumbnail, primary line, secondary
// line joined by " · " — without pulling in its indexer/pagination machinery.
// Mints are still discovered the same way as before: same fromBlock-windowed
// getContractEvents call used by useOwnedHomages (lib/homage/punks.ts), just
// filtered on `from` instead of `to`. Thumbnails are a single batched
// tokenURI read (useReadContracts) over the page's mint ids, same decode
// pattern as HomageBatchReveal's per-token reveal grid.

import {useEffect, useMemo, useState} from "react"
import Link from "next/link"
import {type Address} from "viem"
import {usePublicClient, useReadContracts} from "wagmi"
import {PREFERRED_CHAIN, evmNowTxUrl} from "@/components/tx/tx-ui"
import {evmNowAddressUrl} from "@/lib/collection"
import {homageCollectionAbi} from "@/lib/homage/contracts"
import {ArtistName} from "./ArtistName"

const SCAN_WINDOW = 300_000n
const MAX_ROWS = 12
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

type MintEntry = {tokenId: number; to: `0x${string}`; txHash: `0x${string}`}
type Status = "idle" | "loading" | "ok" | "error"

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

function useRecentMints(collection: `0x${string}`): {mints: MintEntry[]; status: Status} {
  const client = usePublicClient({chainId: PREFERRED_CHAIN.id})
  const [state, setState] = useState<{mints: MintEntry[]; status: Status}>({mints: [], status: "idle"})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!client) {
        setState({mints: [], status: "idle"})
        return
      }
      setState((s) => ({...s, status: "loading"}))
      try {
        const latest = await client.getBlockNumber()
        const fromBlock = latest > SCAN_WINDOW ? latest - SCAN_WINDOW : 0n
        const logs = await client.getContractEvents({
          address: collection,
          abi: homageCollectionAbi,
          eventName: "Transfer",
          args: {from: ZERO_ADDRESS},
          fromBlock,
          toBlock: "latest",
        })
        if (cancelled) return
        const byTokenId = new Map<number, MintEntry>()
        for (const l of logs) {
          const tokenId = (l.args as {tokenId?: bigint}).tokenId
          const to = (l.args as {to?: string}).to
          if (tokenId === undefined || to === undefined || !l.transactionHash) continue
          byTokenId.set(Number(tokenId), {tokenId: Number(tokenId), to: to as `0x${string}`, txHash: l.transactionHash})
        }
        const mints = Array.from(byTokenId.values())
          .sort((a, b) => b.tokenId - a.tokenId)
          .slice(0, MAX_ROWS)
        setState({mints, status: "ok"})
      } catch {
        if (!cancelled) setState({mints: [], status: "error"})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, collection])

  return state
}

/** Single batched tokenURI read over the visible mint ids (not one hook per
 * row) — same RPC-discipline intent as the log scan itself: one round trip
 * for the whole feed, cached for 60s so remounts/re-renders don't re-fetch. */
function useMintThumbnails(collection: Address, mints: MintEntry[]): Map<number, string> {
  const tokenIds = useMemo(() => mints.map((m) => m.tokenId), [mints])
  const contracts = useMemo(
    () =>
      tokenIds.map((id) => ({
        address: collection,
        abi: homageCollectionAbi,
        functionName: "tokenURI" as const,
        args: [BigInt(id)] as const,
        chainId: PREFERRED_CHAIN.id,
      })),
    [collection, tokenIds],
  )
  const {data} = useReadContracts({
    contracts,
    query: {enabled: contracts.length > 0, staleTime: 60_000},
  })
  return useMemo(() => {
    const map = new Map<number, string>()
    tokenIds.forEach((id, i) => {
      const result = data?.[i]
      if (result?.status !== "success" || typeof result.result !== "string") return
      const meta = decodeDataUriJson(result.result)
      if (meta?.image) map.set(id, meta.image)
    })
    return map
  }, [data, tokenIds])
}

export function HomageMintLog({collection, chainId}: {collection: `0x${string}`; chainId: number}) {
  const {mints, status} = useRecentMints(collection)
  const thumbnails = useMintThumbnails(collection, mints)

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Mint history</p>
      {status === "loading" && <p className="font-mono text-[10px] text-gray-400">…</p>}
      {status !== "loading" && mints.length === 0 && (
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">No mints yet.</p>
      )}
      {mints.length > 0 && (
        <ul className="flex flex-col">
          {mints.map((m) => {
            const href = `/collections/${collection}/${m.tokenId}`
            const image = thumbnails.get(m.tokenId)
            return (
              <li key={m.tokenId} className="flex items-center gap-3 border-t border-gray-200 py-2 first:border-t-0">
                <Link
                  href={href}
                  className="relative h-10 w-10 shrink-0 overflow-hidden rounded border border-gray-200 bg-surface-muted/40"
                >
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={image}
                      alt={`Homage to Punk ${m.tokenId}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full animate-pulse bg-gray-100 dark:bg-bg" />
                  )}
                </Link>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-mono">
                    <Link href={href} className="text-fg hover:underline underline-offset-2">
                      Homage to Punk {m.tokenId}
                    </Link>
                  </p>
                  <p className="truncate text-[10px] font-mono text-gray-400">
                    minted by{" "}
                    <a
                      href={evmNowAddressUrl(m.to, chainId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-fg"
                    >
                      <ArtistName address={m.to} />
                    </a>
                    {" · "}
                    <a
                      href={evmNowTxUrl(m.txHash, chainId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-fg"
                    >
                      view tx ↗
                    </a>
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
