"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import type { ArtistIdentity } from "@/lib/artist-queries"
import { useArtistHouse } from "@/components/auction/useArtistHouse"

export function ArtistHeader({
  identity,
  totalWorks,
  activeAuctions,
}: {
  identity: ArtistIdentity
  totalWorks: number
  /** null when the artist has no sovereign auction house deployed. */
  activeAuctions: number | null
}) {
  // Gate the wagmi hook behind a mount check — useReadContract throws during
  // SSR if WagmiProvider isn't reachable, and we want this header to render
  // server-side without errors. Pre-mount the pill simply isn't shown.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return (
    <div className="flex flex-col sm:flex-row items-start gap-6">
      {/* Avatar */}
      {identity.avatarUrl ? (
        <img
          src={identity.avatarUrl}
          alt={identity.displayName}
          className="h-20 w-20 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div
          className="h-20 w-20 shrink-0 rounded-full"
          style={{
            background: `linear-gradient(135deg, ${addressToColor(identity.address, 0)} 0%, ${addressToColor(identity.address, 10)} 100%)`,
          }}
        />
      )}

      {/* Info */}
      <div className="space-y-2 min-w-0">
        <h1 className="text-3xl font-semibold tracking-tight truncate">
          {identity.displayName}
        </h1>
        {identity.ensName && (
          <p className="font-mono text-xs text-gray-400">
            {identity.address.slice(0, 6)}...{identity.address.slice(-4)}
          </p>
        )}
        <div className="flex items-center gap-4 text-sm text-gray-500">
          <span>
            <strong className="text-black">{totalWorks}</strong>{" "}
            {totalWorks === 1 ? "work" : "works"}
          </span>
          {activeAuctions !== null && (
            <span>
              <strong className="text-black">{activeAuctions}</strong>{" "}
              active {activeAuctions === 1 ? "auction" : "auctions"}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center flex-wrap gap-2 pt-1">
          <a
            href={`https://evm.now/address/${identity.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
          >
            evm.now ↗
          </a>
          {mounted && <HouseLinkPill artistAddress={identity.address} />}
          <RefreshPill artistAddress={identity.address} />
        </div>
      </div>
    </div>
  )
}

/** Subcomponent so the wagmi hook only runs on the client (parent gates render). */
function HouseLinkPill({ artistAddress }: { artistAddress: string }) {
  const { houseAddress } = useArtistHouse(artistAddress)
  if (!houseAddress) return null
  return (
    <a
      href={`https://etherscan.io/address/${houseAddress}`}
      target="_blank"
      rel="noopener noreferrer"
      title={houseAddress}
      className="inline-flex items-center gap-1.5 text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
      <span>Auction house</span>
      <span className="font-mono text-gray-400">
        {houseAddress.slice(0, 6)}…{houseAddress.slice(-4)}
      </span>
      <span aria-hidden>↗</span>
    </a>
  )
}

/**
 * In-page flush of the 24h gallery cache. Hits /api/revalidate (unsigned
 * path), which is rate-limited to 1 successful flush per IP per 60s. After
 * a successful flush we call router.refresh() so the SSR'd gallery re-runs
 * with fresh data.
 */
type RefreshState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done" }
  | { kind: "rateLimited"; retryAfter: number }
  | { kind: "error" }

function RefreshPill({ artistAddress }: { artistAddress: string }) {
  const router = useRouter()
  const [state, setState] = useState<RefreshState>({ kind: "idle" })

  // Auto-clear transient states (done/rateLimited/error) after a few seconds
  // so the pill returns to its idle "Refresh" affordance.
  useEffect(() => {
    if (state.kind === "idle" || state.kind === "loading") return
    const t = setTimeout(() => setState({ kind: "idle" }), 4000)
    return () => clearTimeout(t)
  }, [state])

  async function handleClick() {
    if (state.kind === "loading") return
    setState({ kind: "loading" })
    try {
      const res = await fetch(
        `/api/revalidate?artist=${encodeURIComponent(artistAddress)}`,
        { method: "GET", cache: "no-store" },
      )
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as {
          retryAfter?: number
        }
        setState({
          kind: "rateLimited",
          retryAfter: body.retryAfter ?? 60,
        })
        return
      }
      if (!res.ok) {
        setState({ kind: "error" })
        return
      }
      setState({ kind: "done" })
      // Refetch the SSR'd gallery now that the cache is gone.
      router.refresh()
    } catch {
      setState({ kind: "error" })
    }
  }

  const label = (() => {
    switch (state.kind) {
      case "loading":
        return "Refreshing…"
      case "done":
        return "Refreshed ✓"
      case "rateLimited":
        return `Try again in ${state.retryAfter}s`
      case "error":
        return "Failed, retry"
      default:
        return "↻ Refresh"
    }
  })()

  const tone =
    state.kind === "done"
      ? "border-emerald-300 text-emerald-700"
      : state.kind === "rateLimited" || state.kind === "error"
        ? "border-amber-300 text-amber-700"
        : "border-gray-200 text-gray-700 hover:border-gray-400"

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state.kind === "loading"}
      title="Just minted? Force a re-read of the gallery from chain."
      className={`inline-flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-full transition-colors disabled:opacity-60 ${tone}`}
    >
      <span>{label}</span>
    </button>
  )
}

/** Generate a deterministic color from an Ethereum address. */
function addressToColor(address: string, offset: number): string {
  const hex = address.slice(2, 8 + offset)
  const num = parseInt(hex, 16)
  const h = num % 360
  return `hsl(${h}, 60%, 70%)`
}
