/**
 * Global site footer. Renders on every route.
 *
 * Top row carries the tagline + Sites / GitHub / NFTMarket / Contracts /
 * Created-by links. These previously lived inline on the home page
 * (`app/page.tsx`) and the archived index-prev landing; promoting them
 * here gives every route the same chrome and removes the link drift
 * between the two homes.
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

export function Footer() {
  return (
    <footer className="mt-24 border-t border-gray-200 pt-8 pb-16 px-6 md:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-gray-400">
            Artist owned infrastructure on Ethereum
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-400">
            <a href="/sites" className="hover:text-fg transition-colors">
              Sites
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
            <a
              href="https://x.com/ripe0x"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg transition-colors"
            >
              Created by ripe
            </a>
          </div>
        </div>
        <Suspense fallback={null}>
          <SupportersList />
        </Suspense>
      </div>
    </footer>
  )
}
