"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useAccount } from "wagmi"

type SourceState = {
  status: "pending" | "partial" | "complete" | "failed"
  added?: number
  indexedThroughBlock?: string | null
  error?: string | null
}

type RefreshJob = {
  id: string
  status: "queued" | "running" | "partial" | "complete" | "failed"
  result?: { sources?: Record<string, SourceState>; addedTotal?: number }
  error?: string | null
}

type State =
  | { kind: "idle" }
  | { kind: "working"; job: RefreshJob }
  | { kind: "complete"; job: RefreshJob }
  | { kind: "partial"; job: RefreshJob }
  | { kind: "rate-limited"; retryAfterSec: number }
  | { kind: "error"; message: string }

const POLL_MS = 2_000
const DEFAULT_SOURCES = ["Foundation", "Manifold", "Mint", "Transient Labs"]

/** Owner-only control for the durable worker refresh queue. */
export function RefreshButton({ artistAddress }: { artistAddress: string }) {
  const { address: connected } = useAccount()
  const [state, setState] = useState<State>({ kind: "idle" })
  const pollGeneration = useRef(0)
  const router = useRouter()
  const queryClient = useQueryClient()

  useEffect(() => () => {
    pollGeneration.current += 1
  }, [])

  if (
    !connected ||
    connected.toLowerCase() !== artistAddress.toLowerCase()
  ) {
    return null
  }

  async function poll(jobId: string, generation: number): Promise<void> {
    while (generation === pollGeneration.current) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      if (generation !== pollGeneration.current) return
      try {
        const res = await fetch(
          `/api/refresh-artist/${artistAddress}?jobId=${encodeURIComponent(jobId)}`,
          { cache: "no-store" },
        )
        const json = (await res.json()) as
          | { ok: true; job: RefreshJob }
          | { ok: false; error: string }
        if (!res.ok || !json.ok) {
          throw new Error("error" in json ? json.error : "Refresh status failed")
        }
        const job = json.job
        if (job.status === "complete" || job.status === "partial") {
          setState({ kind: job.status, job })
          await queryClient.invalidateQueries({
            queryKey: ["artist-tokens", artistAddress.toLowerCase()],
          })
          router.refresh()
          return
        }
        if (job.status === "failed") {
          setState({ kind: "error", message: job.error ?? "Refresh failed" })
          return
        }
        setState({ kind: "working", job })
      } catch (error) {
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Refresh status failed",
        })
        return
      }
    }
  }

  async function onClick() {
    pollGeneration.current += 1
    const generation = pollGeneration.current
    setState({ kind: "working", job: { id: "", status: "queued" } })
    try {
      const res = await fetch(`/api/refresh-artist/${artistAddress}`, {
        method: "POST",
      })
      const json = (await res.json()) as
        | { ok: true; job: RefreshJob }
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
      setState({ kind: "working", job: json.job })
      void poll(json.job.id, generation)
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Network error",
      })
    }
  }

  const disabled = state.kind === "working"
  const tooltip = disabled ? "Refreshing…" : "Refresh my work"

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
        <RefreshIcon spinning={disabled} />
      </button>
      <div aria-live="polite">
        <RefreshStatus state={state} />
      </div>
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

function RefreshStatus({ state }: { state: State }) {
  if (state.kind === "idle") return null
  if (state.kind === "working") {
    const label = state.job.status === "running" ? "Scanning indexed sources" : "Refresh queued"
    const reported = Object.entries(state.job.result?.sources ?? {})
    const sources =
      reported.length > 0
        ? reported.map(([name, source]) => `${name}: ${source.status}`)
        : DEFAULT_SOURCES.map((name) => `${name}: pending`)
    return (
      <span className="text-[11px] text-gray-500 text-right max-w-xs">
        {label}. {sources.join(" · ")}
      </span>
    )
  }
  if (state.kind === "rate-limited") {
    const min = Math.ceil(state.retryAfterSec / 60)
    return (
      <span className="text-[11px] text-gray-500 text-right max-w-xs">
        Wait {min} minute{min === 1 ? "" : "s"} before refreshing again.
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

  const sources = Object.entries(state.job.result?.sources ?? {})
  const added =
    state.job.result?.addedTotal ??
    sources.reduce((sum, [, source]) => sum + (source.added ?? 0), 0)
  return (
    <span
      className={`text-[11px] text-right max-w-xs ${
        state.kind === "partial" ? "text-amber-600" : "text-gray-500"
      }`}
    >
      {state.kind === "partial" ? "Refresh completed with partial source coverage" : "Refresh complete"}.
      {added > 0 ? ` Found ${added} new ${added === 1 ? "work" : "works"}.` : " No new work found."}
      {sources.length > 0 ? (
        <> {sources.map(([name, source]) => `${name}: ${source.status}`).join(" · ")}</>
      ) : null}
    </span>
  )
}
