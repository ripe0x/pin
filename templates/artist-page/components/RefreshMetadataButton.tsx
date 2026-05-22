"use client"

/**
 * Small "Refresh metadata" control for the auction page. Re-fetches this one
 * token's title/image when its metadata has changed (reveal, correction,
 * swapped media) without waiting for the 24h cache to expire.
 *
 * Hits the public, server-rate-limited /api/refresh-token endpoint, then
 * router.refresh() to pull the updated server-rendered metadata into the
 * page. A local cooldown disables the button so it can't be mashed.
 */
import { useCallback, useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { Address } from "viem"

const COOLDOWN_SEC = 30

export function RefreshMetadataButton({
  tokenContract,
  tokenId,
  auctionId,
}: {
  tokenContract: Address
  tokenId: string
  auctionId: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  useEffect(() => {
    if (cooldown <= 0) return
    const id = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => clearInterval(id)
  }, [cooldown])

  const onClick = useCallback(async () => {
    if (busy || cooldown > 0) return
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch("/api/refresh-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contract: tokenContract, tokenId, auctionId }),
      })
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after")) || COOLDOWN_SEC
        setCooldown(retry)
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setNote(data?.error ?? "Just refreshed — try again shortly.")
        return
      }
      if (!res.ok) {
        setNote("Couldn’t refresh. Try again.")
        return
      }
      setNote("Refreshed")
      setCooldown(COOLDOWN_SEC)
      // Pull the freshly-revalidated server metadata into the current view.
      startTransition(() => router.refresh())
    } catch {
      setNote("Couldn’t refresh. Try again.")
    } finally {
      setBusy(false)
    }
  }, [busy, cooldown, tokenContract, tokenId, auctionId, router])

  const label = busy
    ? "Refreshing…"
    : cooldown > 0
      ? `Refresh metadata (${cooldown}s)`
      : "Refresh metadata"

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy || cooldown > 0}
        title="Re-fetch this token's title and image from its metadata"
        className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span aria-hidden className={busy ? "animate-spin" : undefined}>
          ↻
        </span>{" "}
        {label}
      </button>
      {note ? (
        <span className="text-[10px] font-mono text-gray-400">{note}</span>
      ) : null}
    </div>
  )
}
