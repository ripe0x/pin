"use client"

/**
 * God-mode panel — a small popover next to the wallet-connect button
 * visible only to wallets in the `NEXT_PUBLIC_GOD_MODE_ADDRESSES`
 * allowlist. Toggles per-feature debug flags (currently just the
 * platform-chip overlay on gallery cards).
 *
 * Placed adjacent to the connect button rather than inside RainbowKit's
 * dropdown because the dropdown is an internal RainbowKit primitive
 * and not directly extensible. This keeps the integration surface
 * tiny — one extra button, only renders for the right wallet.
 */

import { useEffect, useRef, useState } from "react"
import { useIsGodMode, useDebugFlag } from "@/lib/useGodMode"

export function GodModePanel() {
  const isGod = useIsGodMode()
  const [open, setOpen] = useState(false)
  const [platformChips, setPlatformChips] = useDebugFlag("platformChips")
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    window.addEventListener("mousedown", onClick)
    return () => window.removeEventListener("mousedown", onClick)
  }, [open])

  if (!isGod) return null

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="God-mode panel"
        title="God mode"
        className="flex h-8 w-8 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
      >
        {/* Wrench icon — keeps the affordance subtle and dev-tool-shaped */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-lg border border-gray-200 bg-surface shadow-lg">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              God mode
            </p>
            <p className="text-[11px] font-mono text-fg-muted mt-1">
              Debug toggles for your wallet only.
            </p>
          </div>
          <ul className="py-2">
            <li className="px-4 py-2 flex items-center justify-between gap-3">
              <div className="flex-1">
                <p className="text-[12px] font-mono text-fg">Platform chips</p>
                <p className="text-[10px] font-mono text-gray-400 mt-0.5">
                  Show source-platform tag on every gallery card.
                </p>
              </div>
              <Toggle
                enabled={platformChips}
                onChange={setPlatformChips}
                label="Platform chips"
              />
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}

function Toggle({
  enabled,
  onChange,
  label,
}: {
  enabled: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        enabled ? "bg-fg" : "bg-gray-200"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-bg transition-transform ${
          enabled ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  )
}
