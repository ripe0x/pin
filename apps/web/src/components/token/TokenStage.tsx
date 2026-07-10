"use client"

/**
 * The token page's art field: TokenMedia plus the two affordances the live
 * view earns — true fullscreen (zero chrome, Escape or click to leave) and
 * the standalone live-view URL (a chrome-free document anyone can share or
 * embed). Fullscreen is sacred: the overlay is the artwork and nothing else.
 */

import { useCallback, useEffect, useState } from "react"
import { TokenMedia } from "@/components/token/TokenMedia"

export function TokenStage({
  imageUrl,
  animationUrl,
  title,
  liveHref,
}: {
  imageUrl: string
  animationUrl?: string | null
  title: string
  /** Standalone chrome-free live view route, when the token has one. */
  liveHref?: string | null
}) {
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

  return (
    <figure className="w-full max-w-[min(80vh,860px)]">
      <TokenMedia imageUrl={imageUrl} animationUrl={animationUrl} title={title} />
      <figcaption className="mt-2 flex items-baseline justify-between gap-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        <span>{animationUrl ? "Live render · from chain state" : "Static image"}</span>
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

      {fullscreen && (
        <div className="fixed inset-0 z-50 bg-bg" role="dialog" aria-label={`${title} fullscreen`}>
          <div className="absolute inset-0 flex items-center justify-center p-0">
            <div className="h-full w-full [&_iframe]:h-full [&_iframe]:w-full [&_img]:h-full [&_img]:w-full [&_img]:object-contain [&_video]:h-full [&_video]:w-full">
              <TokenMedia imageUrl={imageUrl} animationUrl={animationUrl} title={title} />
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Exit fullscreen"
            className="absolute top-4 right-4 z-10 px-3 py-2 text-[11px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg bg-bg/60 backdrop-blur-sm transition-colors"
          >
            Esc ×
          </button>
        </div>
      )}
    </figure>
  )
}
