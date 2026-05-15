"use client"
import { useState } from "react"
import { useAccount } from "wagmi"

/**
 * "Refresh my work" button. Visible only when the connected wallet
 * address matches the page's artist. Clicking POSTs to
 * `/api/refresh-artist/[address]`, which incrementally scans Manifold /
 * SuperRare V2 / Transient Labs / Mint for new mints since the previous
 * scan and writes them to Postgres.
 *
 * Client-side address match is purely UX — hides the button from
 * collectors and crawlers. Cost protection lives on the server: the
 * route gates on `isKnownArtist` and rate-limits at 5 min per address.
 *
 * The button doesn't trigger a page re-render after completion — the
 * lazy_*_artist_tokens rows are server-side, and Next.js's ISR cache
 * won't pick them up until the page revalidates. We tell the user to
 * reload to see new work.
 */
type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ok"
      durationMs: number
      added: Counts
      totals: Counts
      caughtUp: boolean
    }
  | { kind: "rate-limited"; retryAfterSec: number }
  | { kind: "error"; message: string }

type Counts = { manifold: number; srv2: number; tl: number; mint: number }

export function RefreshButton({ artistAddress }: { artistAddress: string }) {
  const { address: connected } = useAccount()
  const [state, setState] = useState<State>({ kind: "idle" })

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
      const json = (await res.json()) as
        | {
            ok: true
            durationMs: number
            totals: Counts
            added: Counts
            caughtUp: boolean
          }
        | { ok: false; error: string; retryAfter?: number }
      if (res.status === 429 && !json.ok) {
        setState({
          kind: "rate-limited",
          retryAfterSec: json.retryAfter ?? 300,
        })
        return
      }
      if (!res.ok || !json.ok) {
        setState({
          kind: "error",
          message: "error" in json ? json.error : "Refresh failed",
        })
        return
      }
      setState({
        kind: "ok",
        durationMs: json.durationMs,
        added: json.added,
        totals: json.totals,
        caughtUp: json.caughtUp,
      })
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      })
    }
  }

  const disabled = state.kind === "loading"

  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        onClick={onClick}
        disabled={disabled}
        className="border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {state.kind === "loading" ? "Refreshing..." : "Refresh my work"}
      </button>
      <RefreshStatus state={state} />
    </div>
  )
}

function RefreshStatus({ state }: { state: State }) {
  if (state.kind === "idle" || state.kind === "loading") return null
  if (state.kind === "rate-limited") {
    const min = Math.ceil(state.retryAfterSec / 60)
    return (
      <span className="text-xs text-gray-500">
        Wait {min} minute{min === 1 ? "" : "s"} before refreshing again
      </span>
    )
  }
  if (state.kind === "error") {
    return <span className="text-xs text-red-600">{state.message}</span>
  }
  // ok
  const secs = Math.max(1, Math.round(state.durationMs / 1000))
  const addedTotal =
    state.added.manifold +
    state.added.srv2 +
    state.added.tl +
    state.added.mint
  const totalsTotal =
    state.totals.manifold +
    state.totals.srv2 +
    state.totals.tl +
    state.totals.mint

  // Catching-up mode: bigger histories need multiple refresh clicks
  // because each scan is bounded by MAX_BLOCKS_PER_SCAN. Tell the user
  // to keep clicking until done.
  if (!state.caughtUp) {
    return (
      <span className="text-xs text-amber-600">
        Found {addedTotal} new piece{addedTotal === 1 ? "" : "s"} on Manifold /
        SuperRare / Transient Labs / Mint so far in {secs}s. Still catching up
        — click again to continue.
      </span>
    )
  }

  // Fully caught up. If we found something, surface it; otherwise just
  // confirm the refresh completed.
  if (addedTotal > 0) {
    return (
      <span className="text-xs text-gray-500">
        Refreshed in {secs}s. Found {addedTotal} new piece
        {addedTotal === 1 ? "" : "s"} on Manifold / SuperRare / Transient Labs
        / Mint.{" "}
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

  // Be explicit about which platforms the button scans. The artist's
  // gallery elsewhere on the site also includes Foundation + Sovereign
  // tokens via Ponder, which are NOT part of the refresh — so the
  // count here may legitimately differ from the gallery's count.
  return (
    <span className="text-xs text-gray-500">
      Refreshed in {secs}s. No new pieces on Manifold / SuperRare / Transient
      Labs / Mint since last scan
      {totalsTotal > 0
        ? ` (${totalsTotal} indexed from these four platforms).`
        : "."}
    </span>
  )
}
