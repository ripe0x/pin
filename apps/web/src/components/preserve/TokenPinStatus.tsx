"use client"

import type { PinStatus } from "@/lib/pinning"

const statusConfig: Record<
  PinStatus,
  { label: string; color: string; bg: string }
> = {
  pinned: { label: "Pinned", color: "text-green-700", bg: "bg-green-100" },
  pinning: { label: "Pinning...", color: "text-yellow-700", bg: "bg-yellow-100" },
  queued: { label: "Pinned", color: "text-green-700", bg: "bg-green-100" },
  failed: { label: "Failed", color: "text-red-700", bg: "bg-red-100" },
  unknown: { label: "Not pinned", color: "text-gray-500", bg: "bg-gray-100" },
}

export function TokenPinStatus({ status }: { status: PinStatus }) {
  const config = statusConfig[status]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${config.color} ${config.bg}`}
    >
      {status === "pinning" && (
        <span className="inline-block h-2 w-2 rounded-full bg-yellow-500 animate-pulse" />
      )}
      {config.label}
    </span>
  )
}
