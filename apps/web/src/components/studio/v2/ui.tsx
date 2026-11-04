"use client"

/** Small shared pieces of the studio's primitive v2 panels. */

import { useState } from "react"
import { formatWriteError } from "@/components/tx/tx-ui"
import { BTN, ERROR, INPUT } from "@/components/studio/create/wizard-ui"

export function Section({
  title,
  help,
  children,
}: {
  title: string
  help: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-gray-200 p-4 space-y-3" aria-label={title}>
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-gray-500 leading-relaxed">{help}</p>
      </div>
      {children}
    </section>
  )
}

/** A label/value grid of current onchain values. */
export function ReadGrid({ title, rows }: { title: string; rows: [string, React.ReactNode][] }) {
  return (
    <div className="rounded border border-gray-200 bg-surface-muted/40 px-3 py-2.5 space-y-1.5">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">{title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px] font-mono text-gray-600">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-gray-400">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function WriteError({ error, action }: { error: unknown; action: string }) {
  if (error === null || error === undefined) return null
  return <p className={ERROR}>{formatWriteError(error, action)}</p>
}

export function Notice({ tone = "gray", children }: { tone?: "gray" | "amber"; children: React.ReactNode }) {
  const cls =
    tone === "amber"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-gray-300 bg-gray-50 text-gray-600"
  return (
    <p role="status" className={`rounded border px-3 py-2 text-xs leading-relaxed ${cls}`}>
      {children}
    </p>
  )
}

/** A one-way action behind typing the collection name. */
export function TypeToConfirm({
  name,
  label,
  busyLabel,
  disabled,
  busy,
  onConfirm,
}: {
  name: string
  label: string
  busyLabel: string | null
  disabled: boolean
  busy: boolean
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState("")
  const matches = typed.trim() === name
  return (
    <div className="space-y-2">
      <label className="block">
        <span className="block text-xs text-gray-500 leading-relaxed mb-1.5">
          This cannot be undone. Type the collection name
          <span className="font-mono"> {name} </span>
          to confirm.
        </span>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={name}
          spellCheck={false}
          aria-label={`Type ${name} to confirm`}
          className={INPUT}
        />
      </label>
      <button type="button" disabled={!matches || disabled || busy} onClick={onConfirm} className={BTN}>
        {busyLabel ?? label}
      </button>
    </div>
  )
}
