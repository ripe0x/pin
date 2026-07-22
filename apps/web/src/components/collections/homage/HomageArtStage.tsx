"use client"

// The token detail's art stage.
//
// The classic view IS the onchain animation document (the renderer's animation_url — the
// same SVG with the conveyor script inlined, dormant until clicked, click again to snap
// home). Rendering it directly means play/pause never reloads or re-fetches anything:
// the interaction is the document's own. The PFP view prefers the renderer's canonical
// onchain circle form, renderSVG(id, status, true) (passed down server-read); the client
// transform is a zero-RPC fallback that derives the same circles from the classic SVG.
//
// Quiet meta row: classic/pfp toggle · PNG export (2400px) · Fullscreen (real
// fullscreen via the Fullscreen API, not a new tab).

import {useEffect, useMemo, useRef, useState} from "react"
import {decodeSvg, downloadBlob, pfpSrc, pfpSvg, svgToPngBlob} from "@/lib/homage/art"

const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"

export function HomageArtStage({
  art,
  animationUrl,
  tokenId,
  onchainPfpSrc,
}: {
  art: string
  animationUrl: string | null
  tokenId: string
  /** Canonical PFP from the renderer contract (renderSVG circle form), when the read succeeds. */
  onchainPfpSrc: string | null
}) {
  const [view, setView] = useState<"classic" | "pfp">("classic")
  const [saving, setSaving] = useState(false)
  const [fs, setFs] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

  const clientPfp = useMemo(() => (onchainPfpSrc ? null : pfpSrc(art)), [onchainPfpSrc, art])
  const pfp = onchainPfpSrc ?? clientPfp
  const showPfp = view === "pfp" && !!pfp

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
      const raw = showPfp ? (onchainPfpSrc ? decodeSvg(onchainPfpSrc) : pfpSvg(art)) : decodeSvg(art)
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
        {!showPfp && animationUrl ? (
          <iframe
            src={animationUrl}
            sandbox="allow-scripts"
            title={`Homage to Punk ${tokenId} — click to play`}
            className={
              fs
                ? "aspect-square h-full max-h-full w-auto max-w-full border-0"
                : "aspect-square w-full border border-gray-200 bg-bg"
            }
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={showPfp ? pfp! : art}
            alt={`Homage to Punk ${tokenId}${showPfp ? " (pfp)" : ""}`}
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
          {pfp && (
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
          {!showPfp && animationUrl && <span className="normal-case text-gray-500">click the art to play</span>}
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
