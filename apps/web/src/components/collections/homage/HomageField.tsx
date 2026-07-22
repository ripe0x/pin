"use client"

// The homage field: the collection's multiplicity, edge to edge. It moves through four
// states — curated samples (deployed, zero mints, mint not open yet), live pre-mint
// samples (zero mints but the mint IS open), the minted collection as tokens land (real
// ids lead, samples fill the rest), and the sold-out collection — derived purely from
// the REAL minted count and the sale window (no display override: the instrument's
// fork-only dev control moves the actual chain, and this field follows it like every
// other surface).
// Every cell renders through the same renderer (renderSVG on any punk id) and, when it's a
// minted token, links to its detail page.
//
// With nothing minted the field shows SampleWall, the curated wall from the pre-deploy
// landing (HomagePreview.tsx, PR #169): synthetic homages generated locally from the
// per-trait color table, zero RPC. Rendering unminted ids through the live renderer
// instead would present art nobody holds as if it were the collection, and on a test
// network with a mock punk-data source every id resolves to the same fixture, so the
// field reads as one image repeated. The first real mint replaces the wall with the
// minted set. The mint being open or closed does not enter into it: what matters is
// whether any token exists to show.

import {useMemo} from "react"
import Link from "next/link"
import {type Address} from "viem"
import {useReadContract} from "wagmi"
import {PREFERRED_CHAIN} from "@/components/tx/tx-ui"
import {STATUS_LIVE, homageRendererViewAbi} from "@/lib/homage/contracts"
import {SampleWall} from "./HomagePreview"

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
  supply,
  minted,
}: {
  collection: Address
  renderer: Address
  mintedIds: number[]
  supply: number
  minted: number
}) {
  const state: FieldState = minted === 0 ? "premint" : minted >= supply ? "soldout" : "minting"

  // The field carries only real mints: never mix samples in with live outputs, which
  // would read as inventory that does not exist.
  const cells = useMemo(() => mintedIds.map((id) => ({id, minted: true})), [mintedIds])

  // The masthead already carries the count/status, so the field bar stays a bare label.
  const label = "The collection"

  // Nothing minted: the curated wall (see file header) instead of the live per-id
  // renderer running over ids nobody holds.
  if (state === "premint") return <SampleWall />

  return (
    <div className="border-y border-gray-200">
      <div className="flex items-center justify-between px-6 py-3 lg:px-12">
        <span className="font-mono text-[10px] uppercase tracking-wider text-gray-400">{label}</span>
      </div>
      {/* Auto-fill masonry with a featured 2x2 lead cell — the varying tile size
          the generic field had. Only feature when there's enough to fill around it. */}
      {/* Container bg = the page ground so trailing empty cells in a sparse (few-mint)
          field vanish rather than showing as blocks; gap-px separates filled tiles.
          (PND's gray scale inverts under .dark, so a gray bg would render light here.)
          max-height caps the field at roughly two rows so a growing mint count never
          pushes the mint instrument further down the page; overflow scrolls internally,
          fade-to-paper gradient signals more below. */}
      <div className="relative">
        <div
          className="grid gap-px overflow-y-auto"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(clamp(150px, 22vw, 300px), 1fr))",
            background: "var(--paper, #0a0a0c)",
            maxHeight: "clamp(420px, 62vw, 800px)",
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
        {cells.length > 8 && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
            style={{background: "linear-gradient(to bottom, transparent, var(--paper, #0a0a0c))"}}
          />
        )}
      </div>
      <div className="flex items-center justify-between px-6 py-3 lg:px-12">
        <Link
          href="#mint-instrument"
          className="font-mono text-[10px] uppercase tracking-wider text-gray-400 underline decoration-dotted underline-offset-4 hover:text-gray-300"
        >
          Mint
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-wider text-gray-400">
          {minted} / {supply} minted
        </span>
      </div>
      {mintedIds.length === 0 && (
        <p className="px-6 py-3 font-mono text-[10px] uppercase tracking-wider text-gray-400 lg:px-12">
          No mints found yet in the scanned window.
        </p>
      )}
    </div>
  )
}
