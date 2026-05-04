"use client"

import { useEffect, useState } from "react"
import { formatTimeRemaining } from "@/lib/format"

export function LiveCountdown({ endTimeSec }: { endTimeSec: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  const remaining = Math.max(0, endTimeSec - now)
  if (remaining === 0) return <>ending</>
  return <>{formatTimeRemaining(remaining)}</>
}
