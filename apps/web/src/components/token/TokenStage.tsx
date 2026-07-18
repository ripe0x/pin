"use client"

/**
 * The token page's art field. For generative tokens (collection has a work
 * config and this token has a real onchain seed) the primary view is the
 * parity render (TokenLiveView) — the artist's code run against the token's
 * real seed, zero heavy RPC, byte-identical to the onchain document by
 * construction (docs/injection-convention.md). Image mode is the existing
 * TokenMedia path: the decoded tokenURI's static image or animation_url,
 * labeled as the captured/static form — deliberately refreshable, not the
 * artwork itself. Non-generative collections (no work code) render
 * TokenMedia only, with no mode toggle: unchanged behavior.
 *
 * Fullscreen (zero chrome, Escape or click to leave) and the standalone
 * live-view URL both follow whichever mode is active. Fullscreen is sacred:
 * the overlay is the artwork and nothing else.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import type { Address } from "viem"
import { TokenMedia } from "@/components/token/TokenMedia"
import { TokenLiveView } from "@/components/token/TokenLiveView"
import type { WorkInput } from "@/lib/collection-render"

type ViewMode = "live" | "image"

const LIVE_CLASS =
  "aspect-square max-h-[80vh] w-full border border-gray-200 dark:border-gray-800 bg-white dark:bg-bg"

// The fullscreen overlay is portaled to document.body (below), so this only
// needs to size the media inside it — no stacking-context fight with the
// page's sticky media column or the site header. img/video keep their
// intrinsic-ratio object-contain sizing. iframe (the parity render and
// TokenMedia's HTML branch) gets aspect-ratio-driven auto sizing instead of
// forced 100%/100%: an iframe is a replaced element with no intrinsic
// ratio, so height:100%+width:100% alongside aspect-square fight each
// other and the square collapses to whichever axis is smaller, leaving the
// rest of the overlay visually uncovered. Auto width/height plus a max-h/
// max-w pair lets the browser solve the square within the viewport cleanly.
const FULLSCREEN_STAGE_CLASS =
  "flex h-full w-full items-center justify-center " +
  "[&_iframe]:aspect-square [&_iframe]:h-auto [&_iframe]:w-auto [&_iframe]:max-h-[92vh] [&_iframe]:max-w-[92vw] [&_iframe]:border-0 " +
  "[&_img]:h-full [&_img]:w-full [&_img]:object-contain [&_video]:h-full [&_video]:w-full"

export function TokenStage({
  imageUrl,
  animationUrl,
  title,
  liveHref,
  work,
  seed,
  collection,
  tokenId,
  hasCapture,
}: {
  imageUrl: string
  animationUrl?: string | null
  title: string
  /** Standalone chrome-free live view route, when the token has one. */
  liveHref?: string | null
  /** Generative work config; omit/null for non-generative collections. */
  work?: WorkInput | null
  /** The token's real onchain seed; needed alongside `work` for the parity render. */
  seed?: `0x${string}` | null
  collection?: Address
  tokenId?: string
  /** Whether tokenURI resolves to a genuine per-token capture, not just the
   *  collection cover — gates whether Image mode has anything distinct to
   *  show. When false for a generative token, Live is the only mode. */
  hasCapture?: boolean
}) {
  const canRenderLive = !!(work && work.code.length > 0 && seed && collection && tokenId)
  const showToggle = canRenderLive && !!hasCapture
  const [mode, setMode] = useState<ViewMode>(canRenderLive ? "live" : "image")
  const [fullscreen, setFullscreen] = useState(false)

  const close = useCallback(() => setFullscreen(false), [])
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    window.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [fullscreen, close])

  const activeMode: ViewMode = canRenderLive ? mode : "image"

  const stage = useMemo(() => {
    if (activeMode === "live" && canRenderLive) {
      return (
        <TokenLiveView
          work={work!}
          seed={seed!}
          tokenId={tokenId!}
          collection={collection!}
          className={LIVE_CLASS}
          title={title}
        />
      )
    }
    return <TokenMedia imageUrl={imageUrl} animationUrl={animationUrl} title={title} />
  }, [activeMode, canRenderLive, work, seed, tokenId, collection, title, imageUrl, animationUrl])

  return (
    <figure className="w-full max-w-[min(80vh,860px)]">
      {stage}
      <figcaption className="mt-2 flex items-baseline justify-between gap-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        {showToggle ? (
          <span className="flex items-baseline gap-3" role="group" aria-label="View mode">
            <button
              type="button"
              onClick={() => setMode("live")}
              aria-pressed={activeMode === "live"}
              className={
                activeMode === "live"
                  ? "text-fg"
                  : "underline decoration-gray-300 underline-offset-2 hover:text-fg transition-colors"
              }
            >
              Live
            </button>
            <button
              type="button"
              onClick={() => setMode("image")}
              aria-pressed={activeMode === "image"}
              className={
                activeMode === "image"
                  ? "text-fg"
                  : "underline decoration-gray-300 underline-offset-2 hover:text-fg transition-colors"
              }
            >
              Image
            </button>
          </span>
        ) : (
          <span>
            {canRenderLive
              ? "Live render · from the onchain seed"
              : animationUrl
                ? "Live render · from chain state"
                : "Static image"}
          </span>
        )}
        <span className="flex shrink-0 items-baseline gap-3">
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="underline decoration-gray-300 underline-offset-2 hover:text-fg transition-colors"
          >
            Fullscreen
          </button>
          {liveHref && (
            <a
              href={liveHref}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-gray-300 underline-offset-2 hover:text-fg transition-colors"
            >
              Live view ↗
            </a>
          )}
        </span>
      </figcaption>

      {fullscreen &&
        typeof document !== "undefined" &&
        createPortal(
          // Portaled to document.body: the media column is `lg:sticky`,
          // which (like any position:sticky/fixed ancestor) establishes its
          // own stacking context, trapping this overlay's z-index below
          // sibling content (the facts column) and the site header despite
          // `fixed inset-0`. Escaping to body is the robust fix, not another
          // z-index bump — fullscreen is sacred, it must truly cover
          // everything.
          <div className="fixed inset-0 z-50 bg-bg" role="dialog" aria-label={`${title} fullscreen`}>
            <div className={FULLSCREEN_STAGE_CLASS}>{stage}</div>
            <button
              type="button"
              onClick={close}
              aria-label="Exit fullscreen"
              className="absolute top-4 right-4 z-10 px-3 py-2 text-[11px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg bg-bg/60 backdrop-blur-sm transition-colors"
            >
              Esc ×
            </button>
          </div>,
          document.body,
        )}
    </figure>
  )
}
