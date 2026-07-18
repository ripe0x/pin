"use client"

/**
 * Keeps a collection page's server-rendered data (config, minted count,
 * lifecycle status) from going stale while a mint could be live — without
 * polling. Fires router.refresh() only when the tab regains focus, and only
 * once per DEBOUNCE_MS: mirrors collection-onchain.ts's config-read TTL (20s),
 * since refreshing sooner would just re-read the same cached row.
 *
 * Render this ONLY for Scheduled/Open collections (see page.tsx). A Closed
 * collection page renders nothing here at all — no listener, no timer, truly
 * static, per the requirements doc's "closed page is a permanent artifact"
 * direction.
 */
import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"

const DEBOUNCE_MS = 20_000

export function CollectionFocusRefresh() {
  const router = useRouter()
  const lastRefresh = useRef(0)

  useEffect(() => {
    function onFocus() {
      const now = Date.now()
      if (now - lastRefresh.current < DEBOUNCE_MS) return
      lastRefresh.current = now
      router.refresh()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [router])

  return null
}
