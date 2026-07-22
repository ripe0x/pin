"use client"

// Mint feed for the homage collection page (thumbnail + "Homage to Punk
// <id>" + minter identity), mirroring the row shape of the homepage
// activity feed (components/home/v2/ActivityRow.tsx) — thumbnail, primary
// line, secondary line joined by " · ". The mint rows arrive as a prop
// from the server page (indexer SELECT over ponder collection_mints, with
// a chain-scan fallback — see getHomageMintFeed in
// lib/homage/collection.server.ts); this component no longer runs its own
// per-visitor Transfer getLogs scan. Thumbnails stay a single batched
// tokenURI read (useReadContracts) over the visible mint ids —
// reveal-dependent, so they can't be cached long anywhere — same decode
// pattern as HomageBatchReveal's per-token reveal grid.

import {useEffect, useMemo, useState} from "react"
import Link from "next/link"
import {type Address} from "viem"
import {useReadContracts} from "wagmi"
import {PREFERRED_CHAIN, evmNowTxUrl} from "@/components/tx/tx-ui"
import {evmNowAddressUrl} from "@/lib/collection"
import {homageCollectionAbi} from "@/lib/homage/contracts"
import type {HomageMintEntry} from "@/lib/homage/collection.server"
import {ArtistName} from "./ArtistName"

type MintEntry = HomageMintEntry

/** "3h ago", "2d ago", etc. — coarse, no live-updating clock needed for a mint feed. */
function formatRelativeTime(unixSeconds: number, nowSeconds: number): string {
  const diff = Math.max(0, nowSeconds - unixSeconds)
  if (diff < 60) return "just now"
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 2_592_000) return `${Math.floor(diff / 86_400)}d ago`
  if (diff < 31_536_000) return `${Math.floor(diff / 2_592_000)}mo ago`
  return `${Math.floor(diff / 31_536_000)}y ago`
}

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

/** Tracks the lg breakpoint (1024px, Tailwind's lg). null until first client paint. */
function useLgViewport(): boolean | null {
  const [lg, setLg] = useState<boolean | null>(null)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    const update = () => setLg(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])
  return lg
}

/** Single batched tokenURI read over the visible mint ids (not one hook per
 * row) — one round trip for the whole feed, cached for 60s so remounts/
 * re-renders don't re-fetch. `enabled` gates the inactive breakpoint copy
 * (see the `variant` prop) so a hidden mount fires no reads. */
function useMintThumbnails(collection: Address, mints: MintEntry[], enabled: boolean): Map<number, string> {
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
    query: {enabled: enabled && contracts.length > 0, staleTime: 60_000},
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

export function HomageMintLog({
  collection,
  chainId,
  mints,
  variant,
}: {
  collection: `0x${string}`
  chainId: number
  /** Server-fetched mint rows (getHomageMintFeed) — the component renders,
   * it does not discover. */
  mints: MintEntry[]
  /** The page mounts a copy per breakpoint (sidebar at lg+, record section below);
   * CSS hides the inactive one but display:none doesn't stop hooks, so each copy
   * declares its breakpoint and only the visible one runs the thumbnail reads.
   * Omit when the component is mounted once. */
  variant?: "desktop" | "mobile"
}) {
  const lg = useLgViewport()
  // null (pre-paint) fetches nothing — the matching copy starts its reads one
  // effect tick later, and the hidden copy never does.
  const active = variant === undefined ? true : lg !== null && (variant === "desktop") === lg
  const thumbnails = useMintThumbnails(collection, mints, active)
  const nowSeconds = useMemo(() => Math.floor(Date.now() / 1000), [])

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Mint history</p>
      {mints.length === 0 && (
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
                    {m.timestamp !== undefined && (
                      <>{formatRelativeTime(m.timestamp, nowSeconds)}{" · "}</>
                    )}
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
