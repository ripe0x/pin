"use client"

import { useEffect, useRef, useState } from "react"
import { useArtistSearch } from "@/components/useArtistSearch"
import { SearchIcon } from "@/components/nav-icons"

/**
 * Desktop collapsible search. Rests as a single icon so the navbar stays
 * quiet, then expands inline into a pill on click — the bar has room at md+,
 * so growth just shifts the actions left and never overflows. On mobile the
 * search lives inside the hamburger menu instead (see MobileMenu), so this
 * component is only mounted in the md+ actions row.
 */
export function HeaderSearch() {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { query, setQuery, submit } = useArtistSearch(() => setOpen(false))

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setQuery("")
      setOpen(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className={`flex items-center overflow-hidden rounded-full transition-all duration-200 ease-out ${
        open
          ? "w-56 gap-2 bg-gray-100 px-3 py-1.5"
          : "h-8 w-8 justify-center gap-0 bg-transparent hover:bg-gray-100"
      }`}
    >
      <button
        type={open ? "submit" : "button"}
        aria-label="Search artists"
        aria-expanded={open}
        onClick={() => {
          if (!open) setOpen(true)
        }}
        className="flex shrink-0 items-center justify-center text-gray-500 transition-colors hover:text-fg"
      >
        <SearchIcon />
      </button>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => {
          // Collapse back to the icon when the user leaves an empty field.
          if (!query.trim()) setOpen(false)
        }}
        onKeyDown={onKeyDown}
        placeholder="Find artist by address or ENS"
        tabIndex={open ? 0 : -1}
        className={`min-w-0 bg-transparent text-[11px] font-mono font-medium uppercase tracking-wider text-gray-600 outline-none placeholder:text-gray-400 placeholder:normal-case placeholder:tracking-normal placeholder:font-normal ${
          open ? "flex-1 opacity-100" : "w-0 opacity-0 pointer-events-none"
        }`}
      />
    </form>
  )
}
