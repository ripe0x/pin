"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { SITE_TITLE } from "@pin/shared"
import { useAccount } from "wagmi"
import { GodModePanel } from "@/components/GodModePanel"
import { PUBLIC_ARTIST_LINKS, studioToolHref } from "@/lib/studio-tools"

export function Navbar() {
  const { address } = useAccount()
  const router = useRouter()
  const [query, setQuery] = useState("")
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

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const input = query.trim()
    if (!input) return
    router.push(`/artist/${encodeURIComponent(input)}`)
    setQuery("")
  }

  const searchForm = (compact: boolean) => (
    <form
      onSubmit={handleSearch}
      className={compact ? "flex w-full" : "hidden md:flex flex-1 max-w-md mx-8"}
    >
      <div className="flex w-full items-center gap-2 rounded-full bg-gray-100 px-3 py-1.5">
        <SearchIcon />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find artist by address or ENS"
          className="flex-1 bg-transparent text-[11px] font-mono font-medium uppercase tracking-wider text-gray-600 outline-none placeholder:text-gray-400 placeholder:normal-case placeholder:tracking-normal placeholder:font-normal"
        />
      </div>
    </form>
  )

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-surface border-b border-gray-200">
      <nav className="mx-auto flex h-16 max-w-[2000px] items-center justify-between px-6">
        {/* Left: logo / wordmark */}
        <Link href="/" className="text-base font-mono font-medium tracking-tight">
          {SITE_TITLE}
        </Link>

        {/* Center (desktop only): Find Artist */}
        {searchForm(false)}

        {/* Right: nav links + wallet */}
        <div className="flex items-center gap-6">
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
                {/* Connected wallets lead with their own spaces: the
                    studio (management) and their public page. */}
                {address ? (
                  <>
                    <Link
                      href={studioToolHref(address)}
                      role="menuitem"
                      onClick={() => setMenuOpen(false)}
                      className="block px-4 py-2 text-xs font-mono font-medium text-fg transition-colors hover:bg-gray-100"
                    >
                      Your studio
                    </Link>
                    <Link
                      href={`/artist/${address.toLowerCase()}`}
                      role="menuitem"
                      onClick={() => setMenuOpen(false)}
                      className="block border-b border-gray-200 px-4 py-2 text-xs font-mono font-medium text-fg transition-colors hover:bg-gray-100"
                    >
                      Your page
                    </Link>
                  </>
                ) : (
                  <Link
                    href="/studio"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="block border-b border-gray-200 px-4 py-2 text-xs font-mono font-medium text-fg transition-colors hover:bg-gray-100"
                  >
                    Studio
                  </Link>
                )}
                {PUBLIC_ARTIST_LINKS.map((a) => (
                  <Link
                    key={a.href}
                    href={a.href}
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="block px-4 py-2 text-xs font-mono text-fg transition-colors hover:bg-gray-100"
                  >
                    {a.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
          {/* First-class studio entry for connected wallets — the
              dropdown row alone buries the management home one click
              too deep. */}
          {address && (
            <Link
              href={studioToolHref(address)}
              className="hidden sm:block text-[11px] font-mono font-medium uppercase tracking-wider text-gray-600 transition-colors hover:text-fg"
            >
              Studio
            </Link>
          )}
          {/* God-mode panel — only renders for allowlisted wallets, so
              this is a no-op for everyone else and adds zero affordance
              clutter on the navbar. */}
          <GodModePanel />
          <ConnectButton.Custom>
            {({
              account,
              chain,
              openAccountModal,
              openChainModal,
              openConnectModal,
              authenticationStatus,
              mounted,
            }) => {
              const ready = mounted && authenticationStatus !== "loading"
              const connected =
                ready &&
                account &&
                chain &&
                (!authenticationStatus ||
                  authenticationStatus === "authenticated")

              const baseBtn =
                "inline-flex items-center gap-2 text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-2 bg-fg text-bg hover:opacity-80 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg"

              return (
                <div
                  {...(!ready && {
                    "aria-hidden": true,
                    style: {
                      opacity: 0,
                      pointerEvents: "none",
                      userSelect: "none",
                    },
                  })}
                >
                  {(() => {
                    if (!connected) {
                      return (
                        <button
                          type="button"
                          onClick={openConnectModal}
                          className={baseBtn}
                        >
                          Connect wallet
                        </button>
                      )
                    }
                    if (chain.unsupported) {
                      return (
                        <button
                          type="button"
                          onClick={openChainModal}
                          className={baseBtn}
                        >
                          Wrong network
                        </button>
                      )
                    }
                    return (
                      <button
                        type="button"
                        onClick={openAccountModal}
                        className={baseBtn}
                      >
                        {process.env.NODE_ENV === "development" &&
                          chain.iconUrl && (
                            <img
                              src={chain.iconUrl}
                              alt={chain.name ?? "chain"}
                              className="h-4 w-4 rounded-full"
                            />
                          )}
                        {account.ensAvatar && (
                          <img
                            src={account.ensAvatar}
                            alt=""
                            className="h-4 w-4 rounded-full"
                          />
                        )}
                        <span>{account.displayName}</span>
                      </button>
                    )
                  })()}
                </div>
              )
            }}
          </ConnectButton.Custom>
        </div>
      </nav>

      {/* Mobile: search lives on its own row so search is a global concern
          on every viewport, not a page-specific affordance. */}
      <div className="md:hidden border-t border-gray-100 px-4 py-2">
        {searchForm(true)}
      </div>
    </header>
  )
}

function SearchIcon() {
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
      className="shrink-0 text-gray-400"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
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
