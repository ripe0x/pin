"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ActivityRow } from "./ActivityRow"
import {
  deserializeFromWire,
  type EnrichedActivityEvent,
  type SerializedActivityEvent,
} from "@/lib/v2-activity-types"

const PAGE_SIZE = 50

type Props = {
  initial: EnrichedActivityEvent[]
  /** When the server's first page is shorter than this, there's no more
   * data; the loader skips the IntersectionObserver wiring entirely. */
  hasMore: boolean
}

type FetchState = "idle" | "loading" | "error" | "done"

/**
 * Client-side infinite scroll wrapper around `ActivityRow`. The first
 * page is rendered server-side and passed in via `initial`; subsequent
 * pages come from `/api/activity?before=…&beforeId=…`. The API
 * resolves token metadata + identity server-side (point lookups thanks
 * to the warmer + ENS pgCache), so the client doesn't fan out to RPC
 * directly.
 *
 * `IntersectionObserver` watches a sentinel element below the last
 * row; when it enters the viewport (~400px ahead) we trigger the next
 * fetch. If the API returns fewer rows than `PAGE_SIZE`, we mark the
 * loader done and tear down the observer.
 */
export function ActivityFeedClient({ initial, hasMore }: Props) {
  const [events, setEvents] = useState<EnrichedActivityEvent[]>(initial)
  const [state, setState] = useState<FetchState>(hasMore ? "idle" : "done")
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // Latest cursor in a ref so the observer callback (set up once)
  // always reads the freshest value without re-binding on each page.
  const cursorRef = useRef<{ blockTime: number; id: string } | null>(
    initial.length > 0
      ? {
          blockTime: initial[initial.length - 1].blockTime,
          id: initial[initial.length - 1].id,
        }
      : null,
  )
  const stateRef = useRef<FetchState>(state)
  stateRef.current = state

  const loadMore = useCallback(async () => {
    if (stateRef.current === "loading" || stateRef.current === "done") return
    const cursor = cursorRef.current
    if (!cursor) {
      setState("done")
      return
    }
    setState("loading")
    try {
      const params = new URLSearchParams({
        before: String(cursor.blockTime),
        beforeId: cursor.id,
        limit: String(PAGE_SIZE),
      })
      const res = await fetch(`/api/activity?${params}`, {
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const body = (await res.json()) as { events: SerializedActivityEvent[] }
      const next = body.events.map(deserializeFromWire)
      setEvents((prev) => [...prev, ...next])
      if (next.length === 0) {
        setState("done")
        return
      }
      const last = next[next.length - 1]
      cursorRef.current = { blockTime: last.blockTime, id: last.id }
      setState(next.length < PAGE_SIZE ? "done" : "idle")
    } catch {
      // Keep the cursor where it was; user can retry by scrolling
      // again or refreshing.
      setState("error")
    }
  }, [])

  useEffect(() => {
    if (state === "done") return
    const node = sentinelRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void loadMore()
          }
        }
      },
      { rootMargin: "400px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [state, loadMore])

  return (
    <>
      <ul className="border-b border-gray-200">
        {events.map((event) => (
          <ActivityRow key={event.id} event={event} />
        ))}
      </ul>
      {state !== "done" ? (
        <div ref={sentinelRef} className="py-8 text-center">
          {state === "loading" ? (
            <p className="font-mono text-xs text-gray-400 italic">
              loading more…
            </p>
          ) : (
            // Always-clickable button when idle/error. The
            // IntersectionObserver triggers `loadMore` automatically
            // when this scrolls into view, but the button is the
            // fallback whenever the observer doesn't fire (some mobile
            // browsers, JS-throttled tabs, headless previews, etc.).
            <button
              type="button"
              onClick={() => void loadMore()}
              className="font-mono text-xs text-gray-500 underline underline-offset-2 hover:text-fg"
            >
              {state === "error" ? "failed to load — retry" : "load more"}
            </button>
          )}
        </div>
      ) : null}
    </>
  )
}
