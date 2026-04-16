"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { SITE_TITLE } from "@pin/shared"
import { useAccount } from "wagmi"

export function Navbar() {
  const { address } = useAccount()
  const router = useRouter()
  const [query, setQuery] = useState("")

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const input = query.trim()
    if (!input) return
    router.push(`/artist/${encodeURIComponent(input)}`)
    setQuery("")
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-200">
      <nav className="mx-auto flex h-16 max-w-[2000px] items-center justify-between px-6">
        {/* Left: logo / wordmark */}
        <Link href="/" className="text-lg font-medium tracking-tight">
          {SITE_TITLE}
        </Link>

        {/* Center: Find Artist */}
        <form
          onSubmit={handleSearch}
          className="hidden md:flex flex-1 max-w-md mx-8"
        >
          <div className="flex w-full items-center gap-2 rounded-full bg-gray-100 px-4 py-2">
            <SearchIcon />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find artist by address or ENS"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
            />
          </div>
        </form>

        {/* Right: nav links + wallet */}
        <div className="flex items-center gap-6">
          {address && (
            <Link
              href={`/artist/${address}`}
              className="hidden text-sm font-medium text-gray-600 transition-colors hover:text-black sm:inline-block"
            >
              Profile
            </Link>
          )}
          <ConnectButton
            showBalance={false}
            accountStatus="avatar"
          />
        </div>
      </nav>
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
