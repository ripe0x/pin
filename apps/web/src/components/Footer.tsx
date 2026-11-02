/**
 * Global site footer. Renders on every route.
 *
 * Top row carries the tagline + About / Sites / GitHub / Created-by
 * links. These previously lived inline on the home page (`app/page.tsx`)
 * and the archived index-prev landing; promoting them here gives every
 * route the same chrome and removes the link drift between the two
 * homes.
 *
 * Below that, a small "Thank you. Supported by:" block lists every
 * unique address that has ever minted from the FundingWorksRipe
 * campaign contract. The list is fetched once per 24h from cache (see
 * `lib/funding-works-supporters.ts`) and Suspense-wrapped so a cold
 * fetch never blocks page paint. When the list is empty (cold RPC
 * outage, or no supporters yet) the entire thank-you block hides
 * itself — see `SupportersList`.
 *
 * Width: the outer <footer> is full-bleed so the top border spans the
 * page on wide token-detail routes (`max-w-[2000px]`) as well as the
 * narrower home (`max-w-3xl`). Content is centered inside an inner
 * wrapper at `max-w-7xl` (1280px) for readable line lengths.
 */
import { Suspense } from "react"
import { SupportersList } from "./SupportersList"
import { ThemeToggle } from "./ThemeToggle"

export function Footer() {
  // Footer chrome shares the site's mono type system (see Navbar / artist header).
  return (
    <footer className="mt-24 border-t border-gray-200 pt-8 pb-16 px-6 md:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <p className="text-xs font-mono text-gray-400">
              Artist owned infrastructure on Ethereum
            </p>
            <div className="mt-4 flex flex-col gap-1">
              <p className="text-[10px] font-mono text-gray-400">
                Created by{" "}
                <a
                  href="https://x.com/ripe0x"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-fg transition-colors"
                >
                  ripe
                </a>
              </p>
              <p className="text-[10px] font-mono text-gray-400">
                PND logo by{" "}
                <a
                  href="/artist/0xc83e83677dd95618686ac9af2cd48972f1b72c22"
                  className="hover:text-fg transition-colors"
                >
                  djkero
                </a>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs font-mono text-gray-400">
            <a href="/about" className="hover:text-fg transition-colors">
              About
            </a>
            <a href="/guides" className="hover:text-fg transition-colors">
              Guides
            </a>
            <a href="/sites" className="hover:text-fg transition-colors">
              Sites
            </a>
            <a href="/log" className="hover:text-fg transition-colors">
              Log
            </a>
            <a href="/objects" className="hover:text-fg transition-colors">
              Objects
            </a>
            <a
              href="https://github.com/ripe0x/pin"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg transition-colors"
            >
              GitHub
            </a>
            <ThemeToggle />
          </div>
        </div>
        <Suspense fallback={null}>
          <SupportersList />
        </Suspense>
      </div>
    </footer>
  )
}
