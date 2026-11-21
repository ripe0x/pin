"use client"
import { useState } from "react"
import { useAccount } from "wagmi"
import { refreshStateFromResponse, type RefreshState } from "./refresh-response"

/**
 * "Refresh my work" icon button. Visible only when the connected wallet
 * address matches the page's artist. Clicking POSTs to
 * `/api/refresh-artist/[address]`, which enqueues a worker job that
 * incrementally scans the artist's platforms (Foundation, Manifold, Mint,
 * Transient Labs) for new mints since the previous scan and writes them
 * to Postgres.
 *
 * The route only enqueues; it returns 202 before the scan runs, so there
 * are no counts to show. We say the refresh is queued and offer a reload
 * (see refresh-response.ts for the response contract).
 *
 * Client-side address match is purely UX — hides the button from
 * collectors and crawlers. Cost protection lives on the server: the
 * route gates on `isKnownArtist`, and the worker dedups per address.
 */
export function RefreshButton({ artistAddress }: { artistAddress: string }) {
  const { address: connected } = useAccount()
  const [state, setState] = useState<RefreshState>({ kind: "idle" })

  if (
    !connected ||
    connected.toLowerCase() !== artistAddress.toLowerCase()
  ) {
    return null
  }

  async function onClick() {
    setState({ kind: "loading" })
    try {
      const res = await fetch(`/api/refresh-artist/${artistAddress}`, {
        method: "POST",
      })
      const json: unknown = await res.json().catch(() => null)
      setState(refreshStateFromResponse(res.status, json))
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      })
    }
  }

  const disabled = state.kind === "loading"
  const tooltip =
    state.kind === "loading" ? "Refreshing…" : "Refresh my work"

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={tooltip}
        title={tooltip}
        className="inline-flex items-center justify-center h-9 w-9 rounded-full border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshIcon spinning={state.kind === "loading"} />
      </button>
      <RefreshStatus state={state} />
    </div>
  )
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? "animate-spin" : undefined}
      aria-hidden
    >
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

function RefreshStatus({ state }: { state: RefreshState }) {
  if (state.kind === "idle" || state.kind === "loading") return null
  if (state.kind === "rate-limited") {
    const min = Math.ceil(state.retryAfterSec / 60)
    return (
      <span className="text-[11px] text-gray-500 text-right max-w-xs">
        Wait {min} minute{min === 1 ? "" : "s"} before refreshing again
      </span>
    )
  }
  if (state.kind === "error") {
    return (
      <span className="text-[11px] text-red-600 text-right max-w-xs">
        {state.message}
      </span>
    )
  }
  // queued
  return (
    <span
      className="text-[11px] text-gray-500 text-right max-w-xs"
      role="status"
    >
      {state.alreadyQueued
        ? "A refresh is already running"
        : "Refresh queued"}{" "}
      — new pieces appear within a few minutes.{" "}
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="underline hover:no-underline"
      >
        Reload
      </button>{" "}
      to see them.
    </span>
  )
}
