"use client"

import { useEffect, useState } from "react"
import type { ArtistIdentity } from "@/lib/artist-queries"
import { useArtistHouse } from "@/components/auction/useArtistHouse"
import { AddressZorb } from "@/components/AddressZorb"
import { CopyAddressButton } from "@/components/CopyAddressButton"

export function ArtistHeader({
  identity,
  totalWorks,
  activeAuctions,
}: {
  identity: ArtistIdentity
  totalWorks: number
  /** null when the artist has no sovereign auction house deployed. */
  activeAuctions: number | null
}) {
  // Gate the wagmi hook behind a mount check — useReadContract throws during
  // SSR if WagmiProvider isn't reachable, and we want this header to render
  // server-side without errors. Pre-mount the pill simply isn't shown.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  const evmNowUrl = `https://evm.now/address/${identity.address}`
  const truncatedAddress = `${identity.address.slice(0, 6)}…${identity.address.slice(-4)}`

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
      {/* Avatar */}
      {identity.avatarUrl ? (
        <img
          src={identity.avatarUrl}
          alt={identity.displayName}
          className="h-20 w-20 shrink-0 rounded-full object-cover"
        />
      ) : (
        <AddressZorb
          address={identity.address}
          className="h-20 w-20 shrink-0 rounded-full"
        />
      )}

      {/* Info */}
      <div className="space-y-3 min-w-0">
        {identity.ensName ? (
          <div className="space-y-1">
            <h1 className="text-base font-mono font-medium tracking-tight truncate">
              {identity.displayName}
            </h1>
            {/* Address verifies against the canonical on-chain record on
                evm.now; copy button hands the full address to the clipboard. */}
            <div className="flex items-center gap-2">
              <a
                href={evmNowUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px] text-gray-500 hover:text-fg transition-colors"
              >
                {truncatedAddress}
              </a>
              <CopyAddressButton address={identity.address} />
            </div>
          </div>
        ) : (
          // No ENS: the truncated address is the heading, linked to evm.now.
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-base font-mono font-medium tracking-tight truncate min-w-0">
              <a
                href={evmNowUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-500 transition-colors"
              >
                {identity.displayName}
              </a>
            </h1>
            <CopyAddressButton address={identity.address} />
          </div>
        )}

        {/* Stats */}
        <div className="flex items-center gap-3 text-[11px] font-mono text-gray-500">
          <span>
            <strong className="font-medium text-fg">{totalWorks}</strong>{" "}
            {totalWorks === 1 ? "indexed work" : "indexed works"}
          </span>
          {activeAuctions !== null && (
            <>
              <span aria-hidden className="text-gray-300">
                ·
              </span>
              <span>
                <strong className="font-medium text-fg">{activeAuctions}</strong>{" "}
                active {activeAuctions === 1 ? "auction" : "auctions"}
              </span>
            </>
          )}
        </div>

        {mounted && <HouseLinkPill artistAddress={identity.address} />}
      </div>
    </div>
  )
}

/** Subcomponent so the wagmi hook only runs on the client (parent gates render). */
function HouseLinkPill({ artistAddress }: { artistAddress: string }) {
  const { houseAddress } = useArtistHouse(artistAddress)
  if (!houseAddress) return null
  return (
    <a
      href={`https://evm.now/address/${houseAddress}`}
      target="_blank"
      rel="noopener noreferrer"
      title={houseAddress}
      className="inline-flex items-center gap-1.5 text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
      <span>Auction house</span>
      <span className="font-mono text-gray-400">
        {houseAddress.slice(0, 6)}…{houseAddress.slice(-4)}
      </span>
      <span aria-hidden>↗</span>
    </a>
  )
}
