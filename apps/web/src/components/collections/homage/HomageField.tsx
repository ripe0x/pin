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
// The curated state reuses SampleWall from the pre-deploy landing (HomagePreview.tsx,
// PR #169): synthetic homages generated locally from the per-trait color table, zero
// RPC. Before mint open the live renderer has nothing distinct to show per id (on a
// test network with a mock punk-data source, every id resolves to the same fixture,
// so the field reads as one image repeated), so the curated wall stands in until real
// variation exists onchain.
//
// "Mint open" here is HomageMinter's own schedule (claimStart/allowlistStart/
// publicStart → currentPhase !== "closed"), the same three reads HomageSchedule and
// HomageMintChip already issue elsewhere on this page. wagmi dedupes identical
// queries against its cache, so this doesn't add a new network round trip — the
// generic Surface `status`/`saleWindowOf` the page derives for the direct-sale CTA
// doesn't apply here, since Homage sells through its own bespoke minter, not the
// generic sale primitive.

import {useMemo} from "react"
import Link from "next/link"
import {type Address} from "viem"
import {useReadContract, useReadContracts} from "wagmi"
import {PREFERRED_CHAIN, useChainNowSec} from "@/components/tx/tx-ui"
import {STATUS_LIVE, homageMinterAbi, homageRendererViewAbi} from "@/lib/homage/contracts"
import {currentPhase, type Schedule} from "@/lib/homage/phase"
import {SampleWall} from "./HomagePreview"

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
  minter,
  mintedIds,
  sampleIds,
  supply,
  minted,
}: {
  collection: Address
  renderer: Address
  // The bespoke HomageMinter, when this collection has one on record. Used only to
  // read its schedule (curated-vs-live gating below); undefined when this skin is
  // forced onto a collection with no homage minter, in which case the gate can't
  // evaluate and the field falls back to the live per-id renderer.
  minter?: Address
  mintedIds: number[]
  sampleIds: number[]
  supply: number
  minted: number
}) {
  const nowSec = useChainNowSec()
  const scheduleReads = useReadContracts({
    contracts: minter
      ? [
          {address: minter, abi: homageMinterAbi, functionName: "claimStart", chainId: PREFERRED_CHAIN.id},
          {address: minter, abi: homageMinterAbi, functionName: "allowlistStart", chainId: PREFERRED_CHAIN.id},
          {address: minter, abi: homageMinterAbi, functionName: "publicStart", chainId: PREFERRED_CHAIN.id},
        ]
      : [],
    query: {enabled: !!minter},
  })
  const schedule: Schedule | null =
    minter && scheduleReads.data?.[0]?.status === "success"
      ? {
          claimStart: Number(scheduleReads.data[0]!.result as bigint),
          allowlistStart: Number(scheduleReads.data[1]!.result as bigint),
          publicStart: Number(scheduleReads.data[2]!.result as bigint),
        }
      : null
  // No minter, or schedule not loaded yet: can't confirm the mint is closed, so
  // don't show the curated wall in place of real data — default to "open" (live field).
  const mintOpen = schedule ? currentPhase(schedule, nowSec) !== "closed" : true

  const state: FieldState = minted === 0 ? "premint" : minted >= supply ? "soldout" : "minting"
  const showCuratedSamples = state === "premint" && !mintOpen

  const cells = useMemo(() => {
    // premint: the sample field. minting/soldout: ONLY real mints — never mix
    // samples in with live outputs (that reads as fake inventory).
    if (state === "premint") return sampleIds.slice(0, GRID_N).map((id) => ({id, minted: false}))
    return mintedIds.map((id) => ({id, minted: true}))
  }, [state, mintedIds, sampleIds])

  // The masthead already carries the count/status, so the field bar stays a bare label.
  const label = state === "premint" ? "Sample outputs" : state === "soldout" ? "The collection" : "The collection"

  // Pre-open, zero mints: curated samples (see file header) instead of the live
  // per-id renderer field.
  if (showCuratedSamples) return <SampleWall />

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
