"use client"

import { useEffect, useState } from "react"

const CAMPAIGN_URL = "https://fund.ripe.wtf"
const TARGET_MS = Date.UTC(2026, 4, 9, 21, 43, 35)

function format(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`
}

export function CampaignBanner() {
  const [remaining, setRemaining] = useState<number | null>(null)

  useEffect(() => {
    const tick = () => setRemaining(TARGET_MS - Date.now())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  if (remaining !== null && remaining <= 0) return null

  return (
    <a
      href={CAMPAIGN_URL}
      target="_blank"
      rel="noreferrer"
      className="block border-b border-gray-200 bg-surface-muted transition-colors hover:bg-gray-100"
    >
      <div className="mx-auto flex h-8 max-w-[2000px] items-center justify-center gap-3 px-4 text-xs text-gray-600">
        <span className="truncate">
          Support ripe building artist owned infrastructure
        </span>
        <span
          className="hidden font-mono tabular-nums text-fg sm:inline"
          suppressHydrationWarning
        >
          {remaining === null ? "—" : format(remaining)}
        </span>
      </div>
    </a>
  )
}
