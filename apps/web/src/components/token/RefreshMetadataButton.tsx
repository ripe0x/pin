"use client"
import { useState } from "react"
import { useAccount } from "wagmi"

/**
 * "Refresh metadata" button on the token page. Shown only when the connected
 * wallet is the token's owner or creator. Re-fetches this token's title/image
 * when its metadata has changed (reveal, correction) or got stuck on a failed
 * fetch, without waiting for the background sweep.
 *
 * Client-side owner/creator match is purely UX — it hides the button from
 * collectors and crawlers. The server route enforces the real protection: a
 * once-per-hour-per-token rate limit. The refresh runs in the worker, so the
 * change isn't instant — we tell the user it lands within a minute and to
 * reload, and lock the button afterward so it isn't mashed.
 */
type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "queued"; message: string }
  | { kind: "rate-limited"; minutes: number }
  | { kind: "error"; message: string }

export function RefreshMetadataButton({
  contract,
  tokenId,
  owner,
  creator,
}: {
  contract: string
  tokenId: string
  owner: string
  creator: string
}) {
  const { address: connected } = useAccount()
  const [state, setState] = useState<State>({ kind: "idle" })

  const lc = connected?.toLowerCase()
  const isOwnerOrCreator =
    !!lc && (lc === owner.toLowerCase() || lc === creator.toLowerCase())
  if (!isOwnerOrCreator) return null

  async function onClick() {
    setState({ kind: "loading" })
    try {
      const res = await fetch(`/api/refresh-token/${contract}/${tokenId}`, {
        method: "POST",
      })
      const json = (await res.json().catch(() => null)) as
        | { ok: true; message: string }
        | { ok: false; error: string; retryAfterMinutes?: number }
        | null

      if (res.status === 429 && json && !json.ok) {
        setState({
          kind: "rate-limited",
          minutes: json.retryAfterMinutes ?? 60,
        })
        return
      }
      if (!res.ok || !json || !json.ok) {
        setState({
          kind: "error",
          message:
            json && !json.ok ? json.error : "Couldn’t refresh. Try again.",
        })
        return
      }
      setState({ kind: "queued", message: json.message })
    } catch {
      setState({ kind: "error", message: "Network error. Try again." })
    }
  }

  // Lock the button after a successful queue or while rate-limited so it
  // can't be re-triggered until a reload.
  const locked = state.kind === "loading" || state.kind === "queued"

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={locked}
        title="Re-fetch this token's title and image from its metadata"
        className="inline-flex w-fit items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span aria-hidden className={state.kind === "loading" ? "animate-spin" : undefined}>
          ↻
        </span>
        {state.kind === "loading" ? "Refreshing…" : "Refresh metadata"}
      </button>
      <StatusLine state={state} />
    </div>
  )
}

function StatusLine({ state }: { state: State }) {
  if (state.kind === "queued") {
    return (
      <span className="text-[11px] font-mono text-gray-500">
        {state.message}{" "}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="underline hover:no-underline"
        >
          Reload
        </button>
      </span>
    )
  }
  if (state.kind === "rate-limited") {
    return (
      <span className="text-[11px] font-mono text-gray-500">
        Recently refreshed — try again in about {state.minutes} minute
        {state.minutes === 1 ? "" : "s"}.
      </span>
    )
  }
  if (state.kind === "error") {
    return <span className="text-[11px] font-mono text-red-600">{state.message}</span>
  }
  return null
}
