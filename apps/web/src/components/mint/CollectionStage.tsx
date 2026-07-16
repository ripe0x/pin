"use client"

/**
 * The left (media) column of the collection page, with a toggle between the
 * shared aggregate hero (the cube) and the full collection gallery. The gallery
 * is only fetched when first shown, so the default cube view costs nothing
 * extra.
 */

import { useState } from "react"
import { OnchainArt } from "./OnchainArt"
import { CollectionGallery } from "./CollectionGallery"

export function CollectionStage({
  collectionId,
  cubeImageUrl,
  cubeAnimationUrl,
  title,
  heroAspect,
  pieceAspect,
  aggregateLabel = "Cube",
}: {
  collectionId: string
  cubeImageUrl: string
  cubeAnimationUrl: string | null
  title: string
  heroAspect?: string
  pieceAspect?: string
  /** Label for the aggregate view ("Cube" for Vouch, else generic). */
  aggregateLabel?: string
}) {
  const [view, setView] = useState<"aggregate" | "all">("aggregate")

  return (
    <div className="flex w-full max-w-[900px] flex-col items-center gap-4">
      <div className="flex gap-1 self-center rounded-full border border-gray-200 p-0.5">
        <Toggle active={view === "aggregate"} onClick={() => setView("aggregate")}>
          {aggregateLabel}
        </Toggle>
        <Toggle active={view === "all"} onClick={() => setView("all")}>
          Collection
        </Toggle>
      </div>

      {view === "aggregate" ? (
        <OnchainArt
          imageUrl={cubeImageUrl}
          animationUrl={cubeAnimationUrl}
          title={title}
          className="w-full"
          aspectRatio={heroAspect}
        />
      ) : (
        <CollectionGallery collectionId={collectionId} aspectRatio={pieceAspect} />
      )}
    </div>
  )
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors ${
        active ? "bg-fg text-bg" : "text-gray-500 hover:text-fg"
      }`}
    >
      {children}
    </button>
  )
}
