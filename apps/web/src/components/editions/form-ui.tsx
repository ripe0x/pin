"use client"

/**
 * Small shared form primitives for the editions create + anchor flows, so the
 * controls share one visual language: mono micro-labels, sans prose, the
 * semantic theme tokens (border / fg-muted / fg-subtle), and a 4px rhythm.
 */

import type { ReactNode } from "react"

/** Mono uppercase micro-label, the field/section caption style. */
export const labelCls =
  "block text-[10px] font-mono uppercase tracking-[0.1em] text-fg-subtle"

/** The shared text-input look. Mono for data legibility; tokenized borders. */
export const inputCls =
  "w-full bg-surface border border-border px-3 py-2.5 text-sm font-mono outline-none transition-colors focus:border-border-strong disabled:opacity-40 placeholder:text-fg-subtle"

/** A labelled field with optional sans help text below the control. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label className={labelCls} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-fg-muted">{hint}</p> : null}
    </div>
  )
}

/** Sans help/prose text, the readable secondary copy. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-fg-muted">{children}</p>
}

export type SegmentedOption = { value: string; label: string }

/**
 * A single bordered segmented control (replaces free-floating pills). Active
 * segment is filled (fg), inactive segments are quiet text — one object, not
 * a row of boxes.
 */
export function Segmented({
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <div
      className={`inline-flex gap-0.5 border border-border bg-surface p-0.5 ${className ?? ""}`}
      role="tablist"
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.1em] transition-colors disabled:opacity-40 ${
              active ? "bg-fg text-bg" : "text-fg-muted hover:text-fg"
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** The shared full-width primary action button (matches MintEditionCTA). */
export const primaryBtnCls =
  "block w-full text-center text-[11px] font-mono font-medium uppercase tracking-[0.1em] py-3 bg-fg text-bg hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
