"use client"

// The homage field: the collection's multiplicity, edge to edge. It moves through three
// states — pre-mint sample outputs, the minted collection as tokens land (real ids lead,
// samples fill the rest), and the sold-out collection — derived purely from the REAL
// minted count (no display override: the instrument's fork-only dev control moves the
// actual chain, and this field follows it like every other surface).
// Every cell renders through the same renderer (renderSVG on any punk id) and, when it's a
// minted token, links to its detail page.

import {useMemo} from "react"
import Link from "next/link"
import {type Address} from "viem"
import {useReadContract} from "wagmi"
import {PREFERRED_CHAIN} from "@/components/tx/tx-ui"
import {STATUS_LIVE, homageRendererViewAbi} from "@/lib/homage/contracts"

const GRID_N = 12
type FieldState = "premint" | "minting" | "soldout"

function svgToSrc(svg: string): string | undefined {
  if (!svg) return undefined
  if (svg.startsWith("data:")) return svg
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function Cell({
  renderer,
  id,
  minted,
  collection,
  featured,
}: {
  renderer: Address
  id: number
  minted: boolean
  collection: Address
  featured?: boolean
}) {
  const {data} = useReadContract({
    address: renderer,
    abi: homageRendererViewAbi,
    functionName: "renderSVG",
    args: [BigInt(id), STATUS_LIVE, false],
    chainId: PREFERRED_CHAIN.id,
    query: {staleTime: 5 * 60_000, retry: 6, retryDelay: (i: number) => Math.min(800 * 2 ** i, 6000)},
  })
  const src = typeof data === "string" ? svgToSrc(data) : undefined
  const span = featured ? "col-span-2 row-span-2" : ""
  const art = (
    <div className={`group relative aspect-square overflow-hidden bg-gray-100 dark:bg-bg ${span}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`Homage to Punk ${id}`} className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full animate-pulse bg-gray-100 dark:bg-bg" />
      )}
      {minted && (
        <span className="absolute bottom-1.5 left-1.5 font-mono text-[9px] uppercase tracking-wider text-white/70 mix-blend-difference">
          {id}
        </span>
      )}
    </div>
  )
  return minted ? (
    <Link
      href={`/collections/${collection}/${id}`}
      className={`block outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${span}`}
    >
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
  const state: FieldState = minted === 0 ? "premint" : minted >= supply ? "soldout" : "minting"

  const cells = useMemo(() => {
    // premint: the sample field. minting/soldout: ONLY real mints — never mix
    // samples in with live outputs (that reads as fake inventory).
    if (state === "premint") return sampleIds.slice(0, GRID_N).map((id) => ({id, minted: false}))
    return mintedIds.map((id) => ({id, minted: true}))
  }, [state, mintedIds, sampleIds])

  // The masthead already carries the count/status, so the field bar stays a bare label.
  const label = state === "premint" ? "Sample outputs" : state === "soldout" ? "The collection" : "The collection"

  return (
    <div className="border-y border-gray-200">
      <div className="flex items-center justify-between px-6 py-3 lg:px-12">
        <span className="font-mono text-[10px] uppercase tracking-wider text-gray-400">{label}</span>
      </div>
      {/* Auto-fill masonry with a featured 2x2 lead cell — the varying tile size
          the generic field had. Only feature when there's enough to fill around it. */}
      {/* Container bg = the page ground so trailing empty cells in a sparse (few-mint)
          field vanish rather than showing as blocks; gap-px separates filled tiles.
          (PND's gray scale inverts under .dark, so a gray bg would render light here.) */}
      <div
        className="grid gap-px"
        style={{
          gridTemplateColumns: "repeat(auto-fill, minmax(clamp(150px, 22vw, 300px), 1fr))",
          background: "var(--paper, #0a0a0c)",
        }}
      >
        {cells.map((c, i) => (
          <Cell
            key={`${c.id}-${i}`}
            renderer={renderer}
            id={c.id}
            minted={c.minted}
            collection={collection}
            featured={i === 0 && cells.length >= 5}
          />
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
