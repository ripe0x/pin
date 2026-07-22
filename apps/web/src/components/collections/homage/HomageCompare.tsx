"use client"

// Punk + homage side by side, static — the single-pair counterpart to the permanence repo's
// offline compare-gif script (generate-pair-gif.mjs), which cycles many pairs into an animated
// GIF via sharp/gifenc (Node-only). One token's detail page only ever needs one pair, so this
// renders the live preview in plain HTML (two <img>s on a shared light field) and builds the
// same look as a real PNG — via compositePairPngBlob, Canvas-only — on demand for Copy/PNG.

import {useMemo, useState} from "react"
import {compositePairPngBlob, decodeSvg, downloadBlob} from "@/lib/homage/art"

const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"
const EXPORT_TILE = 1000

export function HomageCompare({
  art,
  punkImageSrc,
  ground,
  tokenId,
}: {
  art: string
  punkImageSrc: string | null
  /** Shared background behind both tiles — the homage's status ground (the punk has no ground
   *  of its own; mirrors the compare-gif script's choice to share the homage's). */
  ground: string | null
  tokenId: string
}) {
  const [busy, setBusy] = useState<"copy" | "download" | null>(null)
  const [copied, setCopied] = useState(false)

  const homageSvg = useMemo(() => decodeSvg(art), [art])
  const punkSvg = useMemo(() => (punkImageSrc ? decodeSvg(punkImageSrc) : null), [punkImageSrc])
  const groundColor = ground ?? "#6a8494"
  const filename = `homage-${tokenId}-compare.png`

  const buildBlob = () => {
    if (!homageSvg || !punkSvg) throw new Error("missing source SVG")
    return compositePairPngBlob({punkSvg, homageSvg, ground: groundColor, tile: EXPORT_TILE})
  }

  const download = async () => {
    if (busy) return
    setBusy("download")
    try {
      downloadBlob(await buildBlob(), filename)
    } catch {
      // quiet failure — the live preview is on screen either way
    } finally {
      setBusy(null)
    }
  }

  // Same pattern as HomageArtStage's copy button: pass the pending blob promise directly to
  // ClipboardItem (Safari needs the construction to happen synchronously in the click handler's
  // call stack), falling back to a download if the Clipboard API is unavailable or denied.
  const copy = async () => {
    if (busy) return
    setBusy("copy")
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        downloadBlob(await buildBlob(), filename)
        return
      }
      await navigator.clipboard.write([new ClipboardItem({"image/png": buildBlob()})])
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      try {
        downloadBlob(await buildBlob(), filename)
      } catch {
        // quiet failure — the live preview is on screen either way
      }
    } finally {
      setBusy(null)
    }
  }

  if (!homageSvg || !punkSvg) return null

  return (
    <div className="mt-6 space-y-2 border-t border-gray-200 pt-6">
      <p className={META}>Punk + Homage</p>
      <div className="flex gap-[3%] border border-gray-200 p-[7%]" style={{background: "#e8e8e8"}}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={punkImageSrc!}
          alt={`CryptoPunk ${tokenId}`}
          style={{background: groundColor}}
          className="aspect-square w-1/2 shadow-[3px_5px_0_0_rgba(0,0,0,0.15)] [image-rendering:pixelated]"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={art}
          alt={`Homage to Punk ${tokenId}`}
          style={{background: groundColor}}
          className="aspect-square w-1/2 object-contain shadow-[3px_5px_0_0_rgba(0,0,0,0.15)]"
        />
      </div>
      <div className={`flex items-center justify-end gap-3 ${META}`}>
        <button type="button" onClick={copy} disabled={!!busy} className="hover:text-fg disabled:opacity-50">
          {busy === "copy" ? "Copying…" : copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={download} disabled={!!busy} className="hover:text-fg disabled:opacity-50">
          {busy === "download" ? "Saving…" : "PNG ↓"}
        </button>
      </div>
    </div>
  )
}
