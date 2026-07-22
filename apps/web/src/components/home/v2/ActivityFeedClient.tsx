"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ActivityRow } from "./ActivityRow"
import { GroupedMintRow } from "./GroupedMintRow"
import { appendFeedPage } from "@/lib/activity-grouping"
import {
  deserializeFeedItem,
  type EnrichedFeedItem,
  type SerializedFeedItem,
} from "@/lib/v2-activity-types"

const PAGE_SIZE = 50

type Cursor = { blockTime: number; id: string }

type Props = {
  initial: EnrichedFeedItem[]
  /** Cursor of the last RAW event behind `initial` — paging walks the
   * underlying event stream, not the (grouped) display rows. */
  initialCursor: Cursor | null
  /** When the server's first raw page was shorter than the page size,
   * there's no more data; the loader skips the IntersectionObserver
   * wiring entirely. */
  hasMore: boolean
}

type FetchState = "idle" | "loading" | "error" | "done"

/**
 * Client-side infinite scroll wrapper around the feed rows. The first
 * page is rendered server-side and passed in via `initial`; subsequent
 * pages come from `/api/activity?before=…&beforeId=…`. The API resolves
 * identity + media server-side and collapses mint runs, so the client
 * neither fans out to RPC nor re-groups whole pages — it only re-merges
 * the boundary where an appended page continues a run
 * (`appendFeedPage`).
 *
 * `IntersectionObserver` watches a sentinel element below the last
 * row; when it enters the viewport (~400px ahead) we trigger the next
 * fetch. If the API returns a short raw page, we mark the loader done
 * and tear down the observer.
 */
export function ActivityFeedClient({ initial, initialCursor, hasMore }: Props) {
  const [items, setItems] = useState<EnrichedFeedItem[]>(initial)
  const [state, setState] = useState<FetchState>(hasMore ? "idle" : "done")
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // Latest cursor in a ref so the observer callback (set up once)
  // always reads the freshest value without re-binding on each page.
  const cursorRef = useRef<Cursor | null>(initialCursor)
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
      const body = (await res.json()) as {
        items: SerializedFeedItem[]
        nextCursor: Cursor | null
        rawCount: number
        unavailable?: boolean
      }
      if (body.unavailable) throw new Error("unavailable")
      const next = body.items.map(deserializeFeedItem)
      setItems((prev) => appendFeedPage(prev, next))
      if (body.rawCount === 0 || !body.nextCursor) {
        setState("done")
        return
      }
      cursorRef.current = body.nextCursor
      setState(body.rawCount < PAGE_SIZE ? "done" : "idle")
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
        {items.map((item) =>
          item.type === "event" ? (
            <ActivityRow key={item.event.id} event={item.event} />
          ) : (
            <GroupedMintRow key={item.id} group={item} />
          ),
        )}
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
              {state === "error" ? "failed to load, retry" : "load more"}
            </button>
          )}
        </div>
      ) : null}
    </>
  )
}
