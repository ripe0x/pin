"use client"

import Link from "next/link"
import { useArtistHouse } from "@/components/auction/useArtistHouse"

/**
 * "List a single work" card on the studio auctions tab. The link only
 * activates once the artist's Sovereign auction house exists —
 * /auction/new is useless without one, and sending a fresh artist
 * there before deploying reads as a dead end.
 *
 * Uses the same houseOf read DeployHouseCTA and SovereignBulkPanel
 * already fire on this page; wagmi dedupes, so this adds zero RPC.
 */
export function StartSingleAuctionCard({
  artistAddress,
}: {
  artistAddress: string
}) {
  const { houseAddress, isLoading } = useArtistHouse(artistAddress)
  const active = !!houseAddress

  return (
    <div className="border border-gray-200 rounded-md p-4 flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <p className={`text-sm font-medium ${active ? "" : "text-gray-400"}`}>
          List a single work
        </p>
        <p className="text-xs text-gray-500">
          {active
            ? "Paste any ERC-721 you own, or pick from your indexed works."
            : "Available once your auction house is deployed."}
        </p>
      </div>
      {active ? (
        <Link
          href="/auction/new"
          className="shrink-0 text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 border border-gray-300 hover:border-fg transition-colors"
        >
          Start an auction →
        </Link>
      ) : (
        <span
          aria-disabled="true"
          className={`shrink-0 text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 border border-gray-200 text-gray-300 cursor-not-allowed select-none ${
            isLoading ? "animate-pulse" : ""
          }`}
        >
          Start an auction →
        </span>
      )}
    </div>
  )
}
