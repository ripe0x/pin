"use client"

import { useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { PUBLIC_ARTIST_LINKS, studioTools } from "@/lib/studio-tools"

/**
 * Landing for /studio (no address in the URL).
 *
 * - Connected wallet → redirect to /studio/<connected-addr> (same
 *   pattern as CatalogLanding on /catalog).
 * - Not connected → a plain-language overview of every studio tool
 *   with a connect CTA, doubling as the "for artists" landing.
 */
export function StudioLanding() {
  const router = useRouter()
  const { address, isConnected } = useAccount()

  useEffect(() => {
    if (isConnected && address) {
      router.replace(`/studio/${address.toLowerCase()}`)
    }
  }, [isConnected, address, router])

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          For artists
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Studio</h1>
        <p className="text-base text-fg-muted leading-relaxed">
          One place to manage your work. Connect your wallet and your
          studio opens automatically — your public page stays clean for
          collectors while everything administrative lives here.
        </p>
      </header>

      <ConnectButton.Custom>
        {({ openConnectModal }) => (
          <button
            type="button"
            onClick={openConnectModal}
            className="text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-3 bg-fg text-bg hover:opacity-80 transition-colors"
          >
            Connect wallet
          </button>
        )}
      </ConnectButton.Custom>

      <section className="space-y-4">
        <h2 className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          What lives in your studio
        </h2>
        <ul className="space-y-3">
          {studioTools().map((tool) => (
            <li
              key={tool.id}
              className="border border-gray-200 rounded-md p-4 space-y-1"
            >
              <p className="text-sm font-medium">{tool.label}</p>
              <p className="text-sm text-gray-500 leading-relaxed">
                {tool.description}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3 border-t border-gray-100 pt-6">
        <h2 className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          No wallet needed
        </h2>
        <ul className="space-y-2">
          {PUBLIC_ARTIST_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="text-sm text-gray-600 hover:text-fg underline underline-offset-4 transition-colors"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
