"use client"

import { useLayoutEffect, useRef, useState } from "react"

type Props = { text: string }

export function ExpandableDescription({ text }: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const pRef = useRef<HTMLParagraphElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [isOverflowing, setIsOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = pRef.current
    if (!el) return

    const measure = () => {
      const wasExpanded = expanded
      if (wasExpanded) {
        // When expanded, temporarily clamp to measure overflow.
        const prevClass = el.className
        el.className = `${prevClass} line-clamp-5`
        const overflow = el.scrollHeight > el.clientHeight + 1
        el.className = prevClass
        setIsOverflowing(overflow)
      } else {
        setIsOverflowing(el.scrollHeight > el.clientHeight + 1)
      }
    }

    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])

  const handleToggle = () => {
    const next = !expanded
    setExpanded(next)
    if (!next) {
      wrapperRef.current?.scrollIntoView({ block: "nearest" })
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <p
        ref={pRef}
        className={`text-sm text-gray-600 leading-relaxed whitespace-pre-line ${
          expanded ? "" : "line-clamp-5"
        }`}
      >
        {text}
      </p>

      {!expanded && isOverflowing && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white dark:from-gray-100 to-transparent"
        />
      )}

      {isOverflowing && (
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={expanded}
          className="relative mt-2 text-[11px] font-mono uppercase tracking-wider text-gray-600 hover:text-fg transition-colors"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  )
}
