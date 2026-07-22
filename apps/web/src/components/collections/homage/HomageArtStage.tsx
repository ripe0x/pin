"use client"

// The token detail's art stage.
//
// Both views render the same conveyor animation document (the static SVG inlined + the conveyor
// script, dormant until clicked; click again freezes mid-motion, the next click resumes). The doc
// is built client-side from the SVG, so the classic (squares) and PFP (circles) forms share one
// script that detects the form from the inlined shapes. The PFP SVG is the renderer's canonical
// circle form, renderSVG(id, status, true) (passed down server-read); the client transform in
// lib/homage/art.ts derives the same circles from the classic SVG as a zero-RPC fallback.
//
// Quiet meta row: classic/pfp toggle · copy-to-clipboard · PNG export (both 2400px, full
// resolution regardless of the on-screen display size — a right-click "copy image" on the
// <img>/<iframe> below only rasterizes at whatever size the browser happens to be showing it).

import {useMemo, useState} from "react"
import {decodeSvg, downloadBlob, pfpSvg, svgToPngBlob} from "@/lib/homage/art"
import {buildConveyorHtml} from "@/lib/homage/conveyor"

const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"
const EXPORT_SIZE = 2400

export function HomageArtStage({
  art,
  tokenId,
  onchainPfpSrc,
}: {
  art: string
  tokenId: string
  /** Canonical PFP from the renderer contract (renderSVG circle form), when the read succeeds. */
  onchainPfpSrc: string | null
}) {
  const [view, setView] = useState<"classic" | "pfp">("classic")
  const [busy, setBusy] = useState<"copy" | "download" | null>(null)
  const [copied, setCopied] = useState(false)

  // Raw SVG per form: classic straight off the token image; PFP from the onchain circle
  // render, else derived client-side from the classic SVG.
  const classicSvg = useMemo(() => decodeSvg(art), [art])
  const pfpRawSvg = useMemo(
    () => (onchainPfpSrc ? decodeSvg(onchainPfpSrc) : pfpSvg(art)),
    [onchainPfpSrc, art],
  )
  const showPfp = view === "pfp" && !!pfpRawSvg
  // The active view's animation document — both forms animate on click.
  const activeSvg = showPfp ? pfpRawSvg : classicSvg
  const conveyorDoc = useMemo(() => (activeSvg ? buildConveyorHtml(activeSvg) : null), [activeSvg])
  const filename = `homage-${tokenId}${showPfp ? "-pfp" : ""}.png`

  const download = async () => {
    if (busy) return
    setBusy("download")
    try {
      const raw = activeSvg
      if (!raw) return
      downloadBlob(await svgToPngBlob(raw, EXPORT_SIZE), filename)
    } catch {
      // quiet failure — the still is on screen either way
    } finally {
      setBusy(null)
    }
  }

  // Clipboard write takes the blob PROMISE directly (not awaited first) — Safari requires
  // the ClipboardItem be constructed synchronously within the click handler's call stack;
  // passing the pending promise satisfies that while Chrome/Firefox resolve it async same as
  // any other browser. Falls back to a download if the Clipboard API/permission is unavailable,
  // so the image is never just stuck.
  const copy = async () => {
    if (busy) return
    setBusy("copy")
    try {
      const raw = activeSvg
      if (!raw) return
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        downloadBlob(await svgToPngBlob(raw, EXPORT_SIZE), filename)
        return
      }
      await navigator.clipboard.write([new ClipboardItem({"image/png": svgToPngBlob(raw, EXPORT_SIZE)})])
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      try {
        const raw = activeSvg
        if (raw) downloadBlob(await svgToPngBlob(raw, EXPORT_SIZE), filename)
      } catch {
        // quiet failure — the still is on screen either way
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        {conveyorDoc ? (
          <iframe
            srcDoc={conveyorDoc}
            sandbox="allow-scripts"
            title={`Homage to Punk ${tokenId}${showPfp ? " (pfp)" : ""}`}
            className="aspect-square w-full border border-gray-200 bg-bg"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={art}
            alt={`Homage to Punk ${tokenId}`}
            className="aspect-square w-full border border-gray-200 bg-bg object-contain"
          />
        )}
      </div>

      <div className={`flex items-center justify-between gap-4 ${META}`}>
        <span className="flex items-center gap-3">
          {pfpRawSvg && (
            <>
              <button
                type="button"
                onClick={() => setView("classic")}
                className={view === "classic" ? "text-fg" : "hover:text-fg"}
              >
                classic
              </button>
              <button
                type="button"
                onClick={() => setView("pfp")}
                className={view === "pfp" ? "text-fg" : "hover:text-fg"}
              >
                pfp
              </button>
            </>
          )}
        </span>
        <span className="flex items-center gap-3">
          <button type="button" onClick={copy} disabled={!!busy} className="hover:text-fg disabled:opacity-50">
            {busy === "copy" ? "Copying…" : copied ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={download} disabled={!!busy} className="hover:text-fg disabled:opacity-50">
            {busy === "download" ? "Saving…" : "PNG ↓"}
          </button>
        </span>
      </div>
    </div>
  )
}
