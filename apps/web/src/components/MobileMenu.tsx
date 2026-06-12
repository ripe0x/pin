"use client"

import { useEffect, useRef, useState } from "react"
import { ArtistActionLinks } from "@/components/ArtistActionLinks"
import { GodModePanel } from "@/components/GodModePanel"
import { WalletButton } from "@/components/WalletButton"
import { useArtistSearch } from "@/components/useArtistSearch"
import { MenuIcon, SearchIcon } from "@/components/nav-icons"

/**
 * Mobile-only nav. Collapses the search, the "For artists" links, and the
 * wallet button behind a single hamburger so the bar is just logo + menu on
 * small screens. The panel drops below the fixed header and overlays page
 * content (it doesn't grow the bar). Shares ArtistActionLinks / WalletButton /
 * useArtistSearch with the desktop row so there's one source of truth.
 */
export function MobileMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const { query, setQuery, submit } = useArtistSearch(() => setOpen(false))

  // Click-outside + Escape dismiss, matching the desktop dropdown behavior.
  useEffect(() => {
    if (!open) return
    function onPointer(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="md:hidden">
      <button
        type="button"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-full text-gray-600 transition-colors hover:bg-gray-100 hover:text-fg"
      >
        <MenuIcon open={open} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full border-t border-gray-200 bg-surface shadow-lg">
          {/* Search */}
          <form onSubmit={submit} className="px-4 py-3">
            <div className="flex w-full items-center gap-2 rounded-full bg-gray-100 px-3 py-2">
              <SearchIcon />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find artist by address or ENS"
                className="min-w-0 flex-1 bg-transparent text-[11px] font-mono font-medium uppercase tracking-wider text-gray-600 outline-none placeholder:text-gray-400 placeholder:normal-case placeholder:tracking-normal placeholder:font-normal"
              />
            </div>
          </form>

          {/* For artists */}
          <div className="border-t border-gray-200 py-2">
            <p className="px-4 pb-1 text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400">
              For artists
            </p>
            <div role="menu" aria-label="For artists">
              <ArtistActionLinks onNavigate={() => setOpen(false)} />
            </div>
          </div>

          {/* Wallet (+ admin god-mode, a no-op for non-allowlisted wallets) */}
          <div className="flex flex-col gap-2 border-t border-gray-200 px-4 py-3">
            <GodModePanel />
            <WalletButton fullWidth />
          </div>
        </div>
      )}
    </div>
  )
}
