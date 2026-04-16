"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { SITE_TITLE, SITE_DESCRIPTION } from "@commonground/shared"

export default function HomePage() {
  const { address } = useAccount()
  const router = useRouter()
  const [query, setQuery] = useState("")

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const input = query.trim()
    if (!input) return
    router.push(`/artist/${encodeURIComponent(input)}`)
  }

  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12 space-y-16">
      {/* Hero */}
      <section className="flex flex-col items-center text-center pt-16 pb-8 space-y-6">
        <h1 className="text-5xl font-semibold tracking-tight md:text-7xl">
          {SITE_TITLE}
        </h1>
        <p className="max-w-xl text-lg text-gray-600">
          {SITE_DESCRIPTION}
        </p>

        {/* Search */}
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-lg flex gap-3 mt-8"
        >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter an Ethereum address or ENS name"
            className="flex-1 border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-black transition-colors"
          />
          <button
            type="submit"
            disabled={!query.trim()}
            className="bg-black text-white px-6 py-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            View Artist
          </button>
        </form>

        {/* Connect wallet CTA */}
        {address ? (
          <button
            onClick={() => router.push(`/artist/${address}`)}
            className="text-sm text-gray-500 hover:text-black transition-colors underline underline-offset-4"
          >
            View my artist page
          </button>
        ) : (
          <div className="flex flex-col items-center gap-2 pt-4">
            <p className="text-sm text-gray-400">
              Or connect your wallet to view your own page
            </p>
            <ConnectButton
              showBalance={false}
              accountStatus="avatar"
            />
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 pt-8 pb-16">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-gray-400">
            {SITE_TITLE} — preserving art from the Foundation contracts on Ethereum.
          </p>
          <div className="flex gap-6 text-sm text-gray-400">
            <a
              href="https://evm.now/address/0xcDA72070E455bb31C7690a170224Ce43623d0B6f"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-black transition-colors"
            >
              NFTMarket ↗
            </a>
            <a
              href="https://github.com/f8n/fnd-protocol"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-black transition-colors"
            >
              Contracts ↗
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
