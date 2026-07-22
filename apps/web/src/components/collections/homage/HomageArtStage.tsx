"use client"

// The token detail's art stage.
//
// At rest this renders a plain <img>, stamped to a real pixel width/height (see `sizedSvgSrc`)
// so it's natively copy/save/drag-out-able at full resolution — the renderer's raw SVG carries
// only a viewBox, no intrinsic size, so an unstamped <img> (or the animation doc below) gets the
// browser's tiny default natural size regardless of on-screen display size. Clicking engages the
// conveyor animation (the static SVG inlined into an iframe + a script that drives it — it has
// to be inline, scriptable SVG, not an <img>, since the script reorders and reshapes the actual
// ring elements every frame; click again freezes mid-motion, the next click resumes). That inline
// SVG is NOT natively copy-pasteable (browsers don't offer "copy image" on inline vector markup),
// which is what the Copy/PNG buttons below are for regardless of engagement state.
//
// The doc is built client-side from the SVG, so the classic (squares) and PFP (circles) forms
// share one script that detects the form from the inlined shapes. The PFP SVG is the renderer's
// canonical circle form, renderSVG(id, status, true) (passed down server-read); the client
// transform in lib/homage/art.ts derives the same circles from the classic SVG as a zero-RPC
// fallback.
//
// A third stage, "compare" (punk + homage side by side, the single-pair counterpart to the
// permanence repo's offline compare-gif script), is opt-in via the Compare button — not shown by
// default — and Copy/PNG then act on whichever stage is currently on screen.
//
// Quiet meta row: classic/pfp toggle · Compare toggle · copy-to-clipboard · PNG export (both
// 2400px for the single homage, 1000px/tile for the compare pair).

import {useMemo, useState} from "react"
import {
  compositePairPngBlob,
  decodeSvg,
  downloadBlob,
  pfpSvg,
  sizedSvgSrc,
  svgToPngBlob,
} from "@/lib/homage/art"
import {buildConveyorHtml} from "@/lib/homage/conveyor"

const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"
const EXPORT_SIZE = 2400
const COMPARE_TILE = 1000

export function HomageArtStage({
  art,
  tokenId,
  onchainPfpSrc,
  punkImageSrc,
  punkGround,
}: {
  art: string
  tokenId: string
  /** Canonical PFP from the renderer contract (renderSVG circle form), when the read succeeds. */
  onchainPfpSrc: string | null
  /** Source punk image (data URI SVG), for the Compare toggle. Null hides that button. */
  punkImageSrc: string | null
  /** Shared background behind both tiles in Compare — the homage's status ground (the punk has
   *  no ground of its own; mirrors the compare-gif script's choice to share the homage's). */
  punkGround: string | null
}) {
  const [view, setView] = useState<"classic" | "pfp">("classic")
  const [engaged, setEngaged] = useState(false) // true once the viewer has clicked to animate
  const [comparing, setComparing] = useState(false)
  const [busy, setBusy] = useState<"copy" | "download" | null>(null)
  const [copied, setCopied] = useState(false)

  // Raw SVG per form: classic straight off the token image; PFP from the onchain circle
  // render, else derived client-side from the classic SVG.
  const classicSvg = useMemo(() => decodeSvg(art), [art])
  const pfpRawSvg = useMemo(
    () => (onchainPfpSrc ? decodeSvg(onchainPfpSrc) : pfpSvg(art)),
    [onchainPfpSrc, art],
  )
  const punkSvg = useMemo(() => (punkImageSrc ? decodeSvg(punkImageSrc) : null), [punkImageSrc])
  const showPfp = view === "pfp" && !!pfpRawSvg
  // The active view's animation document — both forms animate on click.
  const activeSvg = showPfp ? pfpRawSvg : classicSvg
  const conveyorDoc = useMemo(() => (activeSvg ? buildConveyorHtml(activeSvg) : null), [activeSvg])
  const stillSrc = useMemo(() => (activeSvg ? sizedSvgSrc(activeSvg, EXPORT_SIZE) : art), [activeSvg, art])
  const groundColor = punkGround ?? "#6a8494"
  const canCompare = !!punkImageSrc && !!punkSvg
  const filename = comparing
    ? `homage-${tokenId}-compare.png`
    : `homage-${tokenId}${showPfp ? "-pfp" : ""}.png`

  const buildBlob = () => {
    if (comparing) {
      if (!punkSvg || !activeSvg) throw new Error("missing source SVG")
      return compositePairPngBlob({punkSvg, homageSvg: activeSvg, ground: groundColor, tile: COMPARE_TILE})
    }
    if (!activeSvg) throw new Error("missing source SVG")
    return svgToPngBlob(activeSvg, EXPORT_SIZE)
  }

  const download = async () => {
    if (busy) return
    setBusy("download")
    try {
      downloadBlob(await buildBlob(), filename)
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
        // quiet failure — the still is on screen either way
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        {comparing && punkImageSrc ? (
          <div className="flex aspect-[2/1] w-full gap-[3%] border border-gray-200 p-[7%]" style={{background: "#e8e8e8"}}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={punkImageSrc}
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
        ) : engaged && conveyorDoc ? (
          <iframe
            srcDoc={conveyorDoc}
            sandbox="allow-scripts"
            title={`Homage to Punk ${tokenId}${showPfp ? " (pfp)" : ""}`}
            className="aspect-square w-full border border-gray-200 bg-bg"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={stillSrc}
            alt={`Homage to Punk ${tokenId}`}
            onClick={() => conveyorDoc && setEngaged(true)}
            className={`aspect-square w-full border border-gray-200 bg-bg object-contain ${conveyorDoc ? "cursor-pointer" : ""}`}
          />
        )}
      </div>

      <div className={`flex items-center justify-between gap-4 ${META}`}>
        <span className="flex items-center gap-3">
          {pfpRawSvg && !comparing && (
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
          {canCompare && (
            <button
              type="button"
              onClick={() => setComparing((v) => !v)}
              className={comparing ? "text-fg" : "hover:text-fg"}
            >
              Compare
            </button>
          )}
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
