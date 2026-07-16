"use client"

// Scales a single-line headline to exactly fill its container's width, so the
// title always fits on one line regardless of length (short names go big, long
// names shrink to fit). Pure imperative sizing (no state) to avoid reflow flicker;
// re-fits on container resize. Text width scales linearly with font-size, so we
// measure once at a 100px probe and solve for the fitting size.

import {useEffect, useRef} from "react"

export function FitHeadline({text, className, max = 160}: {text: string; className?: string; max?: number}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const el = textRef.current
    if (!wrap || !el) return
    const fit = () => {
      el.style.fontSize = "100px"
      const w100 = el.scrollWidth
      el.style.fontSize = ""
      const avail = wrap.clientWidth
      if (w100 > 0 && avail > 0) {
        el.style.fontSize = `${Math.min(max, (avail / w100) * 100)}px`
      }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)
    // Web fonts (Anton) load after first paint and change metrics — re-fit then.
    if (typeof document !== "undefined" && "fonts" in document) {
      ;(document as Document & {fonts: FontFaceSet}).fonts.ready.then(fit).catch(() => {})
    }
    return () => ro.disconnect()
  }, [text, max])

  return (
    <div ref={wrapRef} className={className}>
      <span ref={textRef} className="display block whitespace-nowrap" style={{lineHeight: 0.9}}>
        {text}
      </span>
    </div>
  )
}
