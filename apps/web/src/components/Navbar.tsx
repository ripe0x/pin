"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { SITE_TITLE } from "@pin/shared"
import { useAccount } from "wagmi"
import { ArtistActionLinks } from "@/components/ArtistActionLinks"
import { GodModePanel } from "@/components/GodModePanel"
import { HeaderSearch } from "@/components/HeaderSearch"
import { Logo } from "@/components/Logo"
import { MobileMenu } from "@/components/MobileMenu"
import { WalletButton } from "@/components/WalletButton"
import { chromeForPath } from "@/lib/curated-chrome"
import { studioToolHref } from "@/lib/studio-tools"

export function Navbar() {
  const { address } = useAccount()
  const overlay = chromeForPath(usePathname()).navbar === "overlay-dark"
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Click-outside + Escape close the dropdown so it doesn't trap the
  // user once it's open. Keyboard users get the same dismissal that
  // pointer users do.
  useEffect(() => {
    if (!menuOpen) return
    function onPointer(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false)
    }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [menuOpen])

  return (
    // Overlay mode (curated immersive pages): transparent over the page's own
    // dark background, no border, and the scoped `dark` class re-tunes every
    // semantic/gray token for the header subtree (dropdown, search, mobile
    // menu included) without touching next-themes — the site stays light.
    // Known cosmetic gap: RainbowKit modals portal to <body> and keep the
    // global light theme.
    <header
      className={
        overlay
          ? "dark fixed top-0 left-0 right-0 z-50 bg-transparent"
          : "fixed top-0 left-0 right-0 z-50 bg-surface border-b border-gray-200"
      }
    >
      <nav className="mx-auto flex h-16 max-w-[2000px] items-center justify-between px-6">
        {/* Left: logo / wordmark */}
        <Link
          href="/"
          aria-label={`${SITE_TITLE} home`}
          className="flex items-center text-fg transition-opacity hover:opacity-80"
        >
          <Logo className="h-4 w-auto" />
        </Link>

        {/* Desktop (md+): search + nav links + wallet inline. */}
        <div className="hidden items-center gap-6 md:flex">
          <HeaderSearch />
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex items-center gap-1.5 text-[11px] font-mono font-medium uppercase tracking-wider text-gray-600 transition-colors hover:text-fg"
            >
              For artists
              <Chevron open={menuOpen} />
            </button>
            {menuOpen && (
              <div
                role="menu"
                aria-label="For artists"
                className="absolute right-0 mt-2 w-56 rounded-md border border-gray-200 bg-surface py-1 shadow-lg"
              >
                <ArtistActionLinks onNavigate={() => setMenuOpen(false)} />
              </div>
            )}
          </div>
          {/* First-class studio entry for connected wallets — the
              dropdown row alone buries the management home one click
              too deep. */}
          {address && (
            <Link
              href={studioToolHref(address)}
              className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-600 transition-colors hover:text-fg"
            >
              Studio
            </Link>
          )}
          {/* God-mode panel — only renders for allowlisted wallets, so
              this is a no-op for everyone else and adds zero affordance
              clutter on the navbar. */}
          <GodModePanel />
          <WalletButton />
        </div>

        {/* Mobile (<md): everything above collapses behind a hamburger. */}
        <MobileMenu />
      </nav>
    </header>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform ${open ? "rotate-180" : ""}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
