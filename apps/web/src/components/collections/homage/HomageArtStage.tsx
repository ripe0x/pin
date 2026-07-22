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
// Quiet meta row: classic/pfp toggle · PNG export (2400px) · Fullscreen (real
// fullscreen via the Fullscreen API, not a new tab).

import {useEffect, useMemo, useRef, useState} from "react"
import {decodeSvg, downloadBlob, pfpSvg, svgToPngBlob} from "@/lib/homage/art"
import {buildConveyorHtml} from "@/lib/homage/conveyor"

const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"

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
  const [saving, setSaving] = useState(false)
  const [fs, setFs] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    const onChange = () => setFs(!!document.fullscreenElement)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void stageRef.current?.requestFullscreen()
  }

  const download = async () => {
    if (saving) return
    setSaving(true)
    try {
      const raw = activeSvg
      if (!raw) return
      downloadBlob(await svgToPngBlob(raw, 2400), `homage-${tokenId}${showPfp ? "-pfp" : ""}.png`)
    } catch {
      // quiet failure — the still is on screen either way
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={stageRef}
        className={fs ? "flex h-full w-full items-center justify-center bg-[#0a0a0c]" : ""}
      >
        {conveyorDoc ? (
          <iframe
            srcDoc={conveyorDoc}
            sandbox="allow-scripts"
            title={`Homage to Punk ${tokenId}${showPfp ? " (pfp)" : ""}`}
            className={
              fs
                ? "aspect-square h-full max-h-full w-auto max-w-full border-0"
                : "aspect-square w-full border border-gray-200 bg-bg"
            }
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={art}
            alt={`Homage to Punk ${tokenId}`}
            className={
              fs
                ? "aspect-square h-full max-h-full w-auto max-w-full object-contain"
                : "aspect-square w-full border border-gray-200 bg-bg object-contain"
            }
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
          <button type="button" onClick={download} disabled={saving} className="hover:text-fg disabled:opacity-50">
            {saving ? "Saving…" : "PNG ↓"}
          </button>
          <button type="button" onClick={toggleFullscreen} className="hover:text-fg">
            {fs ? "Exit fullscreen" : "Fullscreen"}
          </button>
        </span>
      </div>
    </div>
  )
}
