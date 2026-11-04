"use client"
import { useEffect, useRef, useState } from "react"
import { useAccount } from "wagmi"
import {
  POLL_DELAYS_MS,
  applyStatusPoll,
  describeJob,
  isTerminal,
  refreshStateFromResponse,
  shouldPoll,
  type RefreshState,
} from "./refresh-response"

/**
 * "Refresh my work" icon button. Visible only when the connected wallet
 * address matches the page's artist. Clicking POSTs to
 * `/api/refresh-artist/[address]`, which enqueues a durable worker job
 * (refresh_jobs) that incrementally scans the artist's platforms
 * (Foundation, Manifold, Mint, Transient Labs) for new mints and writes
 * them to Postgres.
 *
 * The route returns before the scan runs, so the button then polls
 * `GET /api/refresh-artist/[address]` a few times with backoff
 * (POLL_DELAYS_MS) and shows queued → running → done (N new) / failed.
 * The first poll that sees the job done also evicts this artist's cached
 * gallery, so a reload shows the new pieces. See refresh-response.ts for
 * the response contract.
 *
 * Client-side address match is purely UX — hides the button from
 * collectors and crawlers. Cost protection lives on the server: the
 * route gates on `isKnownArtist`, a per-IP budget, and a per-artist
 * cooldown; the queue allows one active job per artist.
 */
export function RefreshButton({ artistAddress }: { artistAddress: string }) {
  const { address: connected } = useAccount()
  const [state, setState] = useState<RefreshState>({ kind: "idle" })
  const pollIndex = useRef(0)

  // Follow the job until it's terminal or the poll schedule runs out.
  // Every poll result replaces `state`, which re-runs this effect and
  // schedules the next poll.
  useEffect(() => {
    if (state.kind !== "job" || isTerminal(state.job) || state.gaveUp) return
    if (!shouldPoll(state, pollIndex.current)) {
      setState((s) => (s.kind === "job" ? { ...s, gaveUp: true } : s))
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      pollIndex.current++
      let status = 0
      let json: unknown = null
      try {
        const res = await fetch(`/api/refresh-artist/${artistAddress}`, { cache: "no-store" })
        status = res.status
        json = await res.json().catch(() => null)
      } catch {
        // Network blip: the next scheduled poll retries.
      }
      if (cancelled) return
      setState((s) => {
        const next = applyStatusPoll(s, status, json)
        // A new object even when nothing changed, so the effect re-runs
        // and the schedule advances.
        return next === s && s.kind === "job" ? { ...s } : next
      })
    }, POLL_DELAYS_MS[pollIndex.current])
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [state, artistAddress])

  if (
    !connected ||
    connected.toLowerCase() !== artistAddress.toLowerCase()
  ) {
    return null
  }

  async function onClick() {
    setState({ kind: "loading" })
    pollIndex.current = 0
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

  const busy =
    state.kind === "loading" ||
    (state.kind === "job" && !isTerminal(state.job) && !state.gaveUp)
  const tooltip = busy ? "Refreshing…" : "Refresh my work"

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label={tooltip}
        title={tooltip}
        className="inline-flex items-center justify-center h-9 w-9 rounded-full border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshIcon spinning={busy} />
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

function ReloadLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="underline hover:no-underline"
    >
      Reload
    </button>
  )
}

function RefreshStatus({ state }: { state: RefreshState }) {
  if (state.kind === "idle" || state.kind === "loading") return null
  const base = "text-[11px] text-right max-w-xs"
  if (state.kind === "rate-limited") {
    const min = Math.ceil(state.retryAfterSec / 60)
    return (
      <span className={`${base} text-gray-500`}>
        Refreshed recently. Wait {min} minute{min === 1 ? "" : "s"} before refreshing again
      </span>
    )
  }
  if (state.kind === "error") {
    return <span className={`${base} text-red-600`}>{state.message}</span>
  }
  if (state.kind === "queued") {
    // Legacy fallback: accepted, but no job to follow.
    return (
      <span className={`${base} text-gray-500`} role="status">
        {state.alreadyQueued ? "A refresh is already running" : "Refresh queued"}
        {" "}— new pieces appear within a few minutes. <ReloadLink /> to see them.
      </span>
    )
  }
  const { job } = state
  const text = describeJob(job, state.alreadyQueued)
  if (job.status === "failed") {
    return <span className={`${base} text-red-600`} role="status">{text}</span>
  }
  return (
    <span className={`${base} text-gray-500`} role="status">
      {text}
      {job.status === "done" && (job.added ?? 1) > 0 && (
        <>. <ReloadLink /> to see them.</>
      )}
      {!isTerminal(job) && state.gaveUp && (
        <> — still going; new pieces appear when it finishes. <ReloadLink /> later.</>
      )}
    </span>
  )
}
