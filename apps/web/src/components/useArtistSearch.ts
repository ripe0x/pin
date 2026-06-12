"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

/**
 * Shared artist-search submit. Both the desktop collapsible pill
 * (HeaderSearch) and the mobile menu field route to /artist/<input>, so the
 * query state + navigation live here once instead of being copied per surface.
 *
 * `onAfterSubmit` lets the caller close its own UI (collapse the pill, close
 * the mobile menu) after a successful navigation.
 */
export function useArtistSearch(onAfterSubmit?: () => void) {
  const router = useRouter()
  const [query, setQuery] = useState("")

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const input = query.trim()
    if (!input) return
    router.push(`/artist/${encodeURIComponent(input)}`)
    setQuery("")
    onAfterSubmit?.()
  }

  return { query, setQuery, submit }
}
