"use client"

// The homage field: the collection's multiplicity, edge to edge. It moves through three
// states — pre-mint sample outputs, the minted collection as tokens land (real ids lead,
// samples fill the rest), and the sold-out collection. A fork-only dev toggle previews each.
// Every cell renders through the same renderer (renderSVG on any punk id) and, when it's a
// minted token, links to its detail page.

import {useMemo, useState} from "react"
import Link from "next/link"
import {type Address} from "viem"
import {useReadContract} from "wagmi"
import {PREFERRED_CHAIN} from "@/components/tx/tx-ui"
import {STATUS_LIVE, homageRendererViewAbi} from "@/lib/homage/contracts"

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const GRID_N = 12
type FieldState = "premint" | "minting" | "soldout"

function svgToSrc(svg: string): string | undefined {
  if (!svg) return undefined
  if (svg.startsWith("data:")) return svg
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function Cell({renderer, id, minted, collection}: {renderer: Address; id: number; minted: boolean; collection: Address}) {
  const {data} = useReadContract({
    address: renderer,
    abi: homageRendererViewAbi,
    functionName: "renderSVG",
    args: [BigInt(id), STATUS_LIVE, false],
    chainId: PREFERRED_CHAIN.id,
    query: {staleTime: 5 * 60_000, retry: 6, retryDelay: (i: number) => Math.min(800 * 2 ** i, 6000)},
  })
  const src = typeof data === "string" ? svgToSrc(data) : undefined
  const art = (
    <div className="group relative aspect-square overflow-hidden bg-gray-100 dark:bg-bg">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`Homage to Punk #${id}`} className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full animate-pulse bg-gray-100 dark:bg-bg" />
      )}
      {minted && (
        <span className="absolute bottom-1.5 left-1.5 font-mono text-[9px] uppercase tracking-wider text-white/70 mix-blend-difference">
          #{id}
        </span>
      )}
    </div>
  )
  return minted ? (
    <Link href={`/collections/${collection}/${id}`} className="block outline-none focus-visible:ring-2 focus-visible:ring-white/40">
      {art}
    </Link>
  ) : (
    art
  )
}

export function HomageField({
  collection,
  renderer,
  mintedIds,
  sampleIds,
  supply,
  minted,
}: {
  collection: Address
  renderer: Address
  mintedIds: number[]
  sampleIds: number[]
  supply: number
  minted: number
}) {
  const [dev, setDev] = useState<FieldState | null>(null)

  const auto: FieldState = minted === 0 ? "premint" : minted >= supply ? "soldout" : "minting"
  const state = dev ?? auto

  const cells = useMemo(() => {
    if (state === "premint") return sampleIds.slice(0, GRID_N).map((id) => ({id, minted: false}))
    if (state === "soldout") return mintedIds.map((id) => ({id, minted: true}))
    // minting: real ids lead, samples fill the field until enough real mints exist
    const real = mintedIds.map((id) => ({id, minted: true}))
    const fill = sampleIds.filter((id) => !mintedIds.includes(id)).map((id) => ({id, minted: false}))
    return [...real, ...fill].slice(0, Math.max(GRID_N, real.length))
  }, [state, mintedIds, sampleIds])

  const label =
    state === "premint"
      ? "Sample outputs"
      : state === "soldout"
        ? "Sold out · the collection"
        : `Minted so far · ${minted} / ${supply}`

  return (
    <div className="border-y border-gray-200">
      <div className="flex items-center justify-between px-6 py-3 lg:px-12">
        <span className="font-mono text-[10px] uppercase tracking-wider text-gray-400">{label}</span>
        {FORK_MODE && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] uppercase tracking-wider text-gray-500">dev field</span>
            {(["premint", "minting", "soldout", null] as const).map((s) => (
              <button
                key={s ?? "live"}
                onClick={() => setDev(s)}
                className={`font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  dev === s ? "bg-fg text-bg" : "text-gray-400 hover:text-fg"
                }`}
              >
                {s ?? "live"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {cells.map((c, i) => (
          <Cell key={`${c.id}-${i}`} renderer={renderer} id={c.id} minted={c.minted} collection={collection} />
        ))}
      </div>
      {state !== "premint" && mintedIds.length === 0 && (
        <p className="px-6 py-3 font-mono text-[10px] uppercase tracking-wider text-gray-400 lg:px-12">
          No mints found yet in the scanned window.
        </p>
      )}
    </div>
  )
}
