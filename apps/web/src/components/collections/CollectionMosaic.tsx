"use client"

/**
 * The mosaic: a generative collection's hero is its MULTIPLICITY, not one
 * framed picture. An edge-to-edge field of outputs, one featured cell
 * breaking the grid, and a focus overlay for any single output. The art
 * tiles flush to the viewport with only hairline seams: no gray field, no
 * captions per cell, no chrome competing. Color comes entirely from the
 * work.
 *
 * ParityMosaic mixes real mints with sample outputs for works whose code we
 * hold (live client iframes, sample seeds generated client-side, free to
 * roll, with a Regenerate control); it says so, and reshuffles on every
 * page load. Real mints there are never shuffled or relabeled: they are the
 * collection, shown as themselves.
 *
 * OnchainMosaic shows only real mints for renderer-native works: each
 * tile's own tokenURI, read server-side and decoded once per token (see
 * getCollectionTokenRenders), with no sample fill and no reroll, since the
 * grid is exactly the minted set.
 */

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { Address } from "viem"

import { TokenPreview, type TokenData } from "@/lib/collection-render"
import type { RenderableSample } from "@/lib/collection-onchain"
import { selectMosaicTileVisual, type MosaicTileVisual } from "@/lib/collection-mosaic-tile"
import { OptimizedImage } from "@/components/OptimizedImage"
import type { WorkConfig } from "@/lib/collection"
import {
  entryTokenData,
  exploreSeed,
  toWorkInput,
  useRenderContext,
  type RenderEntry,
} from "./GenerativeViews"

export type MosaicItem = {
  key: string
  /** Grid cell content (cheap: static image or a lazy iframe). */
  thumb: React.ReactNode
  /** Focus-overlay content (the live, interactive render). */
  full: React.ReactNode
  /** Focus overline: "Token #14" or "Sample output". */
  overline: string
  /** Token page link when this is a real mint. */
  href?: string
  /** A rollable sample (vs. a real mint, which is fixed). */
  isSample: boolean
}

// A crypto-strong throwaway seed for a client-rendered sample.
function randomSeed(): `0x${string}` {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`
}

// ── presentational shell ────────────────────────────────────────────────

function MosaicShell({
  items,
  framing,
  onRegenerate,
  regenerating,
  onRerollItem,
}: {
  items: MosaicItem[]
  /** Left-side label for the control bar (null hides the bar entirely). */
  framing: string | null
  /** Rolls a whole fresh set of samples. Absent → no Regenerate control. */
  onRegenerate?: () => void
  regenerating?: boolean
  /** Rolls the single sample at `index` in place (the focus "new seed"). */
  onRerollItem?: (index: number) => void | Promise<void>
}) {
  const [focus, setFocus] = useState<number | null>(null)
  const [rerolling, setRerolling] = useState(false)

  const close = useCallback(() => setFocus(null), [])
  useEffect(() => {
    if (focus === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    window.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [focus, close])

  const active = focus !== null ? items[focus] : null

  async function rerollActive() {
    if (focus === null || !onRerollItem) return
    setRerolling(true)
    try {
      await onRerollItem(focus)
    } finally {
      setRerolling(false)
    }
  }

  return (
    <>
      {framing && (
        <div className="flex items-center justify-between gap-4 border-y border-gray-200 px-6 py-3 lg:px-12">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            {framing}
          </p>
          {onRegenerate && (
            <button
              type="button"
              onClick={() => onRegenerate()}
              disabled={regenerating}
              className="shrink-0 text-[10px] font-mono uppercase tracking-wider text-gray-500 underline decoration-gray-300 underline-offset-2 hover:text-fg transition-colors disabled:opacity-40"
            >
              {regenerating ? "Rolling…" : "Regenerate ↻"}
            </button>
          )}
        </div>
      )}

      {/* Edge-to-edge field. The first cell is featured (2x2) so the grid
          has rhythm instead of reading as a uniform contact sheet; because
          the set is shuffled, which output is featured differs each load. */}
      <div
        className="grid gap-px bg-gray-200 dark:bg-gray-900"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(clamp(150px, 22vw, 300px), 1fr))" }}
      >
        {items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFocus(i)}
            className={`group relative block aspect-square overflow-hidden bg-gray-100 dark:bg-bg ${
              i === 0 ? "col-span-2 row-span-2" : ""
            }`}
          >
            {item.thumb}
            <span className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-t from-black/50 via-transparent to-transparent p-3 opacity-0 transition-opacity group-hover:opacity-100">
              <span className="text-[10px] font-mono uppercase tracking-wider text-white">
                {item.href ? item.overline : "View"}
              </span>
            </span>
          </button>
        ))}
      </div>

      {/* Focus overlay: one output, large and live. */}
      {active && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-sm"
          role="dialog"
          aria-label={active.overline}
        >
          <div className="flex items-center justify-between px-6 py-4 lg:px-12">
            <span className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
              {active.overline}
              {active.isSample && " · your mint will differ"}
            </span>
            <div className="flex items-center gap-5 text-[11px] font-mono uppercase tracking-wider">
              {active.isSample && onRerollItem && (
                <button
                  type="button"
                  onClick={() => void rerollActive()}
                  disabled={rerolling}
                  className="text-gray-500 underline decoration-gray-400 underline-offset-2 hover:text-fg transition-colors disabled:opacity-40"
                >
                  {rerolling ? "Rolling…" : "New seed ↻"}
                </button>
              )}
              {active.href && (
                <Link
                  href={active.href}
                  className="text-gray-500 underline decoration-gray-400 underline-offset-2 hover:text-fg transition-colors"
                >
                  Open token →
                </Link>
              )}
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="text-gray-500 hover:text-fg transition-colors"
              >
                Esc ×
              </button>
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center px-6 pb-8 lg:px-12">
            <div className="aspect-square h-full max-h-full w-auto max-w-full [&>iframe]:h-full [&>iframe]:w-full [&>img]:h-full [&>img]:w-full [&>img]:object-contain">
              {active.full}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── parity engine (works whose code we hold) ────────────────────────────

const PARITY_TARGET = 14 // grid tiles to fill toward (real mints + samples)
const PARITY_MINTS_CAP = 14 // don't mount more than this many live iframes
const PARITY_SSR_OFFSET = 3000 // deterministic seeds for the first paint

export function ParityMosaic({
  collection,
  work,
  entries,
  minted,
}: {
  collection: Address
  work: WorkConfig
  entries: RenderEntry[]
  minted: string
}) {
  const { resolver, gunzip, chainId } = useRenderContext()
  const workInput = useMemo(() => toWorkInput(work), [work])
  const nextTokenId = String(BigInt(minted) + 1n)

  const mintTiles = useMemo(() => entries.slice(0, PARITY_MINTS_CAP), [entries])
  const sampleCount = Math.max(0, PARITY_TARGET - mintTiles.length)

  // Deterministic seeds for SSR/first paint (no hydration mismatch), then
  // randomized on mount so every page load shows a fresh set.
  const [seeds, setSeeds] = useState<string[]>(() =>
    Array.from({ length: sampleCount }, (_, i) => exploreSeed(collection, PARITY_SSR_OFFSET + i)),
  )
  useEffect(() => {
    if (sampleCount > 0) setSeeds(Array.from({ length: sampleCount }, () => randomSeed()))
  }, [sampleCount, collection])

  const regenerate = useCallback(() => {
    setSeeds(Array.from({ length: sampleCount }, () => randomSeed()))
  }, [sampleCount])

  const rerollItem = useCallback(
    (index: number) => {
      const s = index - mintTiles.length
      if (s < 0) return // a real mint, not a sample
      setSeeds((prev) => {
        const next = prev.slice()
        next[s] = randomSeed()
        return next
      })
    },
    [mintTiles.length],
  )

  const items = useMemo<MosaicItem[]>(() => {
    if (!resolver) return []
    const cell = (tokenData: TokenData, key: string, overline: string, href?: string): MosaicItem => ({
      key,
      overline,
      href,
      isSample: !href,
      thumb: (
        <TokenPreview
          work={workInput}
          tokenData={tokenData}
          resolver={resolver}
          gunzip={gunzip}
          className="h-full w-full pointer-events-none"
          title={overline}
        />
      ),
      full: (
        <TokenPreview
          work={workInput}
          tokenData={tokenData}
          resolver={resolver}
          gunzip={gunzip}
          className="aspect-square h-full w-full"
          title={overline}
        />
      ),
    })
    const mints = mintTiles.map((e) =>
      cell(
        entryTokenData(e, collection, chainId, work.injectionVersion),
        `m${e.tokenId}`,
        `Token #${e.tokenId}`,
        `/collections/${collection.toLowerCase()}/${e.tokenId}`,
      ),
    )
    const samples = seeds.map((seed, i) =>
      cell(
        {
          hash: seed,
          tokenId: nextTokenId,
          collection: collection.toLowerCase(),
          chainId,
          version: work.injectionVersion,
          context: "preview",
        },
        // Key by position so an in-place reroll swaps content without a remount.
        `s${i}`,
        "Sample output",
      ),
    )
    return [...mints, ...samples]
  }, [resolver, gunzip, workInput, mintTiles, seeds, collection, chainId, work.injectionVersion, nextTokenId])

  if (!resolver) return <div className="h-[70vh] w-full bg-gray-100 dark:bg-bg" />

  // Honest label: the bar names samples whenever any are present (they fill
  // the field until enough real mints exist), and disappears once the field
  // is entirely real mints. Real mints always lead and stay clickable, so
  // they're never mistaken for samples.
  const framing =
    sampleCount > 0 ? "Sample outputs · every mint is generated from its own transaction" : null
  return (
    <MosaicShell
      items={items}
      framing={framing}
      onRegenerate={sampleCount > 0 ? regenerate : undefined}
      onRerollItem={rerollItem}
    />
  )
}

// ── onchain engine (renderer-native works via previewURI) ───────────────

export function OnchainMosaic({
  collection,
  tokenIds,
  renders,
  cover = null,
}: {
  collection: `0x${string}`
  /** The minted ids this grid shows, from selectGridTokenIds. Never a
   *  speculative "next N" guess: every id here is a real mint. */
  tokenIds: number[]
  /** Each id's decoded tokenURI (see getCollectionTokenRenders), keyed by
   *  token id. An id with no entry, or a null entry, falls through to the
   *  cover then a numbered placeholder like any other id with nothing of
   *  its own to show. */
  renders: Record<number, RenderableSample | null>
  /** The collection's own cover (contractURI image), shown on a tile whose
   *  render has neither an image nor a live-rendered slot. Null when the
   *  collection has no cover. */
  cover?: string | null
}) {
  const items = useMemo<MosaicItem[]>(
    () =>
      tokenIds.map((id, position) => {
        const render = renders[id] ?? null
        const visual = selectMosaicTileVisual({
          image: render?.kind === "image" ? render.src : null,
          html: render?.kind === "html" ? render.html : null,
          cover,
          number: id,
          position,
        })
        return {
          key: `t${id}`,
          overline: `Token #${id}`,
          isSample: false,
          href: `/collections/${collection.toLowerCase()}/${id}`,
          thumb: renderMosaicTileThumb(visual),
          full: renderMosaicTileFull(render, cover, id),
        }
      }),
    [tokenIds, renders, cover, collection],
  )

  if (items.length === 0) return null
  return <MosaicShell items={items} framing={null} />
}

/** Renders a grid tile from selectMosaicTileVisual's choice. `pointer-events-none`
 *  on the iframe so a click still reaches the tile's own button: an iframe's
 *  content is a separate document and never bubbles its clicks to the parent. */
function renderMosaicTileThumb(visual: MosaicTileVisual) {
  switch (visual.kind) {
    case "image":
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={visual.src} alt="token" className="h-full w-full object-cover" />
    case "cover":
      return (
        <div className="relative h-full w-full">
          <OptimizedImage src={visual.src} alt="token" width={300} className="h-full w-full object-cover" />
          <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-mono text-white">
            #{visual.number}
          </span>
        </div>
      )
    case "iframe":
      return (
        <iframe
          title="token"
          sandbox="allow-scripts"
          loading="lazy"
          srcDoc={visual.html}
          className="h-full w-full border-0 pointer-events-none"
        />
      )
    case "number":
      return (
        <div className="flex h-full w-full items-center justify-center bg-neutral-100 dark:bg-neutral-900">
          <span className="font-mono text-xs text-neutral-400">#{visual.number}</span>
        </div>
      )
  }
}

/** The focus overlay for one grid tile: the full render, not the thumb's
 *  iframe-count cap (a single enlarged tile costs nothing extra to render
 *  live, cap or no cap). */
function renderMosaicTileFull(render: RenderableSample | null, cover: string | null, id: number) {
  if (render?.kind === "html") {
    return (
      <iframe
        title={`Token #${id}`}
        sandbox="allow-scripts"
        srcDoc={render.html}
        className="aspect-square h-full w-full border-0"
      />
    )
  }
  if (render?.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={render.src} alt={`Token #${id}`} className="h-full w-full object-contain" />
  }
  if (cover) {
    return (
      <OptimizedImage
        src={cover}
        alt={`Token #${id}`}
        width={1200}
        className="h-full w-full object-contain"
      />
    )
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-neutral-100 dark:bg-neutral-900">
      <span className="font-mono text-sm text-neutral-400">#{id}</span>
    </div>
  )
}
