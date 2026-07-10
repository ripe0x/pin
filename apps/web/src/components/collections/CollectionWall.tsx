"use client"

/**
 * The wall: the collection page's full-bleed gallery field. One large live
 * render on the wall, with a range strip of small live cells beneath it —
 * the latest mints once minting has started, numbered example outputs
 * before (plus a reroll cell). Clicking a cell hangs it on the wall.
 *
 * Range is what makes a generative collection legible AS a collection:
 * a single render reads like a token page; a wall with a strip reads like
 * a body of work. All cells are parity renders (shared dependency fetch,
 * zero tokenURI calls).
 */

import Link from "next/link"
import { useMemo, useState } from "react"
import type { Address } from "viem"

import { TokenPreview, type TokenData } from "@/lib/collection-render"
import type { WorkConfig } from "@/lib/collection"
import {
  exploreSeed,
  entryTokenData,
  toWorkInput,
  useRenderContext,
  type RenderEntry,
} from "./GenerativeViews"

/** What's hanging on the wall. */
type Hung =
  | { kind: "mint"; entry: RenderEntry }
  | { kind: "explore"; index: number }

const STRIP_MINTS = 6
const STRIP_SAMPLES = 5
/** Explore-seed offset for the wall strip: distinct from the hero's reroll
 *  walk (0..) and ExploreGrid's samples (1000..). */
const WALL_SAMPLE_OFFSET = 2000

export function CollectionWall({
  collection,
  work,
  entries,
  minted,
}: {
  collection: Address
  work: WorkConfig
  /** Latest mints, newest first (server-provided). */
  entries: RenderEntry[]
  minted: string
}) {
  const { resolver, gunzip, chainId } = useRenderContext()
  const hasMints = entries.length > 0
  const [hung, setHung] = useState<Hung>(
    hasMints ? { kind: "mint", entry: entries[0] } : { kind: "explore", index: 0 },
  )
  const [rerollCount, setRerollCount] = useState(0)

  const nextTokenId = String(BigInt(minted) + 1n)
  const stageData = useMemo<TokenData>(() => {
    if (hung.kind === "mint") {
      return entryTokenData(hung.entry, collection, chainId, work.injectionVersion)
    }
    return {
      hash: exploreSeed(collection, WALL_SAMPLE_OFFSET + hung.index),
      tokenId: nextTokenId,
      collection: collection.toLowerCase(),
      chainId,
      version: work.injectionVersion,
      context: "preview",
    }
  }, [hung, collection, chainId, work.injectionVersion, nextTokenId])

  const stripMints = entries.slice(0, STRIP_MINTS)
  const sampleIndices = useMemo(
    () =>
      Array.from(
        { length: hasMints ? Math.max(0, STRIP_SAMPLES - stripMints.length) : STRIP_SAMPLES },
        (_, i) => i,
      ),
    [hasMints, stripMints.length],
  )

  if (!resolver) {
    return <div className="h-[70vh] w-full bg-gray-100 dark:bg-bg" />
  }

  const workInput = toWorkInput(work)

  return (
    <section className="bg-gray-100 dark:bg-bg border-b border-gray-200">
      <div className="mx-auto flex max-w-[1400px] flex-col items-center px-6 pt-10 pb-6 lg:px-12 lg:pt-14">
        {/* The wall itself. */}
        <figure className="w-full max-w-[min(62vh,760px)]">
          <TokenPreview
            work={workInput}
            tokenData={stageData}
            resolver={resolver}
            gunzip={gunzip}
            className="aspect-square w-full border border-gray-200 dark:border-gray-800"
            title={
              hung.kind === "mint"
                ? `token ${hung.entry.tokenId} live render`
                : "example output"
            }
          />
          <figcaption className="mt-2 flex items-baseline justify-between gap-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <span>
              {hung.kind === "mint" ? (
                <>
                  Token #{hung.entry.tokenId} · live render from its onchain seed ·{" "}
                  <Link
                    href={`/collections/${collection.toLowerCase()}/${hung.entry.tokenId}`}
                    className="underline hover:text-fg"
                  >
                    Open token →
                  </Link>
                </>
              ) : (
                "Example output · your mint will differ"
              )}
            </span>
            {hung.kind === "explore" && (
              <button
                type="button"
                onClick={() => {
                  setRerollCount((n) => n + 1)
                  setHung({
                    kind: "explore",
                    index: STRIP_SAMPLES + rerollCount + 1,
                  })
                }}
                className="shrink-0 underline decoration-gray-300 underline-offset-2 hover:text-fg transition-colors"
              >
                New seed ↻
              </button>
            )}
          </figcaption>
        </figure>

        {/* The range strip: mints first, samples fill the rest. */}
        <div className="mt-6 flex w-full items-start justify-center gap-2 overflow-x-auto pb-1">
          {stripMints.map((e) => (
            <StripCell
              key={`m${e.tokenId}`}
              selected={hung.kind === "mint" && hung.entry.tokenId === e.tokenId}
              onSelect={() => setHung({ kind: "mint", entry: e })}
              label={`#${e.tokenId}`}
            >
              <TokenPreview
                work={workInput}
                tokenData={entryTokenData(e, collection, chainId, work.injectionVersion)}
                resolver={resolver}
                gunzip={gunzip}
                className="h-full w-full pointer-events-none"
                title={`token ${e.tokenId}`}
              />
            </StripCell>
          ))}
          {sampleIndices.map((i) => (
            <StripCell
              key={`s${i}`}
              selected={hung.kind === "explore" && hung.index === i}
              onSelect={() => setHung({ kind: "explore", index: i })}
              label="ex."
            >
              <TokenPreview
                work={workInput}
                tokenData={{
                  hash: exploreSeed(collection, WALL_SAMPLE_OFFSET + i),
                  tokenId: nextTokenId,
                  collection: collection.toLowerCase(),
                  chainId,
                  version: work.injectionVersion,
                  context: "preview",
                }}
                resolver={resolver}
                gunzip={gunzip}
                className="h-full w-full pointer-events-none"
                title={`example output ${i + 1}`}
              />
            </StripCell>
          ))}
        </div>
      </div>
    </section>
  )
}

function StripCell({
  selected,
  onSelect,
  label,
  children,
}: {
  selected: boolean
  onSelect: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="group shrink-0 text-left"
    >
      <span
        className={`block h-20 w-20 overflow-hidden border transition-colors ${
          selected
            ? "border-fg"
            : "border-gray-200 dark:border-gray-800 group-hover:border-gray-400"
        }`}
      >
        {children}
      </span>
      <span
        className={`mt-1 block text-[10px] font-mono ${
          selected ? "text-fg" : "text-gray-400 group-hover:text-gray-600"
        }`}
      >
        {label}
      </span>
    </button>
  )
}
