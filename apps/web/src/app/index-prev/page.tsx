import { Suspense } from "react"
import { SITE_TITLE } from "@pin/shared"
import { HomeSquare } from "@/components/home/HomeSquare"
import { AmbientCounters } from "@/components/home/AmbientCounters"

export default function HomePage() {
  return (
    <div className="mx-auto max-w-[2000px] px-6 py-8 space-y-12">
      {/* The page itself is the square. Hero, work, and artists share a
          single grid composition so the establishing shot and the first
          row of work read in one eye-line. */}
      <Suspense fallback={null}>
        <HomeSquare />
      </Suspense>

      {/* Ambient counters — single-line sentence above the footer. */}
      <Suspense fallback={null}>
        <AmbientCounters />
      </Suspense>

      {/* Footer */}
      <footer className="border-t border-gray-200 pt-8 pb-16">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-gray-400">
            {SITE_TITLE} — open artist infrastructure on Ethereum.
          </p>
          <div className="flex gap-6 text-sm text-gray-400">
            <a
              href="/sites"
              className="hover:text-fg transition-colors"
            >
              Sites
            </a>
            <a
              href="https://x.com/ripe0x"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg transition-colors"
            >
              Created by ripe
            </a>
            <a
              href="https://github.com/ripe0x/pin"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://evm.now/address/0xcDA72070E455bb31C7690a170224Ce43623d0B6f"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg transition-colors"
            >
              NFTMarket
            </a>
            <a
              href="https://github.com/f8n/fnd-protocol"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg transition-colors"
            >
              Contracts
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
