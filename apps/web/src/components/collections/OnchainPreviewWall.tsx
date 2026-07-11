"use client"

/**
 * The wall for renderer-native works: collections with no parity work
 * config (custom or Solidity-SVG renderers) whose renderer implements the
 * OPTIONAL onchain previewURI extension. Same composition as
 * CollectionWall — the work large, a range strip beneath, reroll — but
 * every render comes from the chain itself (server-cached previewURI
 * calls), because that's the only faithful source for a renderer whose
 * algorithm lives in Solidity.
 *
 * Renderers without the extension never reach this component (the page
 * probes server-side); their pages keep the honest cover/no-artwork field.
 */

import { useState } from "react"
import type { OnchainPreview } from "@/lib/collection-onchain"

function PreviewMedia({
  preview,
  title,
  className,
}: {
  preview: OnchainPreview
  title: string
  className?: string
}) {
  if (preview.animationUrl) {
    return (
      <iframe
        className={className}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        src={preview.animationUrl}
      />
    )
  }
  if (preview.image) {
    // Data-URI SVG straight from the renderer; plain <img>, no gateways.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={preview.image} alt={title} />
  }
  return <div className={className} />
}

export function OnchainPreviewWall({
  collection,
  previews,
}: {
  collection: `0x${string}`
  /** Server-fetched initial previews (seed indices 0..n). */
  previews: OnchainPreview[]
}) {
  const [pool, setPool] = useState<OnchainPreview[]>(previews)
  const [hungIndex, setHungIndex] = useState(0)
  const [busy, setBusy] = useState(false)

  const hung = pool.find((p) => p.seedIndex === hungIndex) ?? pool[0]

  async function reroll() {
    setBusy(true)
    const next = Math.max(...pool.map((p) => p.seedIndex)) + 1
    try {
      const res = await fetch(`/api/collections/${collection.toLowerCase()}/preview?i=${next}`)
      if (res.ok) {
        const p = (await res.json()) as OnchainPreview
        setPool((prev) => [...prev, p])
        setHungIndex(p.seedIndex)
      }
    } finally {
      setBusy(false)
    }
  }

  if (!hung) return null

  return (
    <section className="bg-gray-100 dark:bg-bg border-b border-gray-200">
      <div className="mx-auto flex max-w-[1400px] flex-col items-center px-6 pt-10 pb-6 lg:px-12 lg:pt-14">
        <figure className="w-full max-w-[min(62vh,760px)]">
          <PreviewMedia
            preview={hung}
            title="example output"
            className="aspect-square w-full border border-gray-200 dark:border-gray-800 object-contain bg-white dark:bg-black"
          />
          <figcaption className="mt-2 flex items-baseline justify-between gap-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <span>Example output · rendered onchain · your mint will differ</span>
            <button
              type="button"
              onClick={() => void reroll()}
              disabled={busy}
              className="shrink-0 underline decoration-gray-300 underline-offset-2 hover:text-fg transition-colors disabled:opacity-40"
            >
              {busy ? "Rendering…" : "New seed ↻"}
            </button>
          </figcaption>
        </figure>

        <div className="mt-6 flex w-full items-start justify-center gap-2 overflow-x-auto pb-1">
          {pool.map((p) => (
            <button
              key={p.seedIndex}
              type="button"
              onClick={() => setHungIndex(p.seedIndex)}
              aria-pressed={p.seedIndex === hung.seedIndex}
              className="group shrink-0 text-left"
            >
              <span
                className={`block h-20 w-20 overflow-hidden border transition-colors ${
                  p.seedIndex === hung.seedIndex
                    ? "border-fg"
                    : "border-gray-200 dark:border-gray-800 group-hover:border-gray-400"
                }`}
              >
                <PreviewMedia
                  preview={p}
                  title={`example output ${p.seedIndex + 1}`}
                  className="h-full w-full object-cover pointer-events-none"
                />
              </span>
              <span
                className={`mt-1 block text-[10px] font-mono ${
                  p.seedIndex === hung.seedIndex
                    ? "text-fg"
                    : "text-gray-400 group-hover:text-gray-600"
                }`}
              >
                ex.
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
