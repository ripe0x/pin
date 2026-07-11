"use client"

/**
 * The mosaic: a generative collection's hero is its MULTIPLICITY, not one
 * framed picture. An edge-to-edge field of live outputs — the engine
 * throwing off variations — with one featured cell breaking the grid, and a
 * focus overlay for any single output. The art tiles flush to the viewport
 * with only hairline seams; no gray field, no captions per cell, no chrome
 * competing. Color comes entirely from the work.
 *
 * Two engines feed the same shell: ParityMosaic renders works whose code we
 * hold (live client iframes), OnchainMosaic renders renderer-native works
 * from their onchain previewURI (static SVG in the grid, interactive in
 * focus). Both share MosaicShell so the composition is identical.
 */

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { Address } from "viem"

import { TokenPreview, type TokenData } from "@/lib/collection-render"
import type { OnchainPreview } from "@/lib/collection-onchain"
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
  /** Overline shown in focus: "Token #14" or "Example output". */
  overline: string
  /** Token page link when this is a real mint. */
  href?: string
}

// ── presentational shell ────────────────────────────────────────────────

function MosaicShell({
  items,
  onReroll,
  rerolling,
}: {
  items: MosaicItem[]
  /** Adds a fresh example and focuses it. Absent → no reroll affordance. */
  onReroll?: () => void
  rerolling?: boolean
}) {
  const [focus, setFocus] = useState<number | null>(null)

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

  return (
    <>
      {/* Edge-to-edge field. The first cell is featured (2x2) so the grid
          has rhythm instead of reading as a uniform contact sheet. Seams
          are the page bg showing through a 1px gap. */}
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
              {!active.href && " · your mint will differ"}
            </span>
            <div className="flex items-center gap-5 text-[11px] font-mono uppercase tracking-wider">
              {onReroll && (
                <button
                  type="button"
                  onClick={() => onReroll()}
                  disabled={rerolling}
                  className="text-gray-500 underline decoration-gray-400 underline-offset-2 hover:text-fg transition-colors disabled:opacity-40"
                >
                  {rerolling ? "Rendering…" : "New seed ↻"}
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

const PARITY_EXAMPLE_OFFSET = 3000
const PARITY_MAX_TILES = 12

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
  const [exampleCount, setExampleCount] = useState(0)
  const nextTokenId = String(BigInt(minted) + 1n)
  const workInput = useMemo(() => toWorkInput(work), [work])

  // Real mints lead; examples fill the field up to the cap.
  const exampleSlots = Math.max(
    entries.length === 0 ? 8 : 0,
    Math.min(PARITY_MAX_TILES - entries.length, PARITY_MAX_TILES) + exampleCount,
  )

  const items = useMemo<MosaicItem[]>(() => {
    if (!resolver) return []
    const cell = (tokenData: TokenData, key: string, overline: string, href?: string): MosaicItem => ({
      key,
      overline,
      href,
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
    const mintTiles = entries
      .slice(0, PARITY_MAX_TILES)
      .map((e) =>
        cell(
          entryTokenData(e, collection, chainId, work.injectionVersion),
          `m${e.tokenId}`,
          `Token #${e.tokenId}`,
          `/collections/${collection.toLowerCase()}/${e.tokenId}`,
        ),
      )
    const exampleTiles = Array.from({ length: exampleSlots }, (_, i) =>
      cell(
        {
          hash: exploreSeed(collection, PARITY_EXAMPLE_OFFSET + i),
          tokenId: nextTokenId,
          collection: collection.toLowerCase(),
          chainId,
          version: work.injectionVersion,
          context: "preview",
        },
        `e${i}`,
        "Example output",
      ),
    )
    return [...mintTiles, ...exampleTiles]
  }, [resolver, gunzip, workInput, entries, exampleSlots, collection, chainId, work.injectionVersion, nextTokenId])

  if (!resolver) return <div className="h-[70vh] w-full bg-gray-100 dark:bg-bg" />
  return <MosaicShell items={items} onReroll={() => setExampleCount((n) => n + 1)} />
}

// ── onchain engine (renderer-native works via previewURI) ───────────────

export function OnchainMosaic({
  collection,
  previews,
}: {
  collection: `0x${string}`
  previews: OnchainPreview[]
}) {
  const [pool, setPool] = useState<OnchainPreview[]>(previews)
  const [busy, setBusy] = useState(false)

  const reroll = useCallback(async () => {
    setBusy(true)
    const next = Math.max(...pool.map((p) => p.seedIndex)) + 1
    try {
      const res = await fetch(`/api/collections/${collection.toLowerCase()}/preview?i=${next}`)
      if (res.ok) {
        const p = (await res.json()) as OnchainPreview
        setPool((prev) => [...prev, p])
      }
    } finally {
      setBusy(false)
    }
  }, [collection, pool])

  const items = useMemo<MosaicItem[]>(
    () =>
      pool.map((p) => ({
        key: `p${p.seedIndex}`,
        overline: "Example output",
        // Static SVG in the grid: clean and cheap, no interactive overlay.
        thumb: p.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.image} alt="example output" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full" />
        ),
        // Interactive HTML in focus when the renderer provides it.
        full: p.animationUrl ? (
          <iframe
            title="example output"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={p.animationUrl}
            className="aspect-square h-full w-full"
          />
        ) : p.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.image} alt="example output" className="h-full w-full object-contain" />
        ) : (
          <div className="h-full w-full" />
        ),
      })),
    [pool],
  )

  if (items.length === 0) return null
  return <MosaicShell items={items} onReroll={reroll} rerolling={busy} />
}
