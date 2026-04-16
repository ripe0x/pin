"use client"

import type { ArtistIdentity } from "@/lib/artist-queries"

export function ArtistHeader({
  identity,
  totalWorks,
}: {
  identity: ArtistIdentity
  totalWorks: number
}) {
  return (
    <div className="flex flex-col sm:flex-row items-start gap-6">
      {/* Avatar */}
      {identity.avatarUrl ? (
        <img
          src={identity.avatarUrl}
          alt={identity.displayName}
          className="h-20 w-20 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div
          className="h-20 w-20 shrink-0 rounded-full"
          style={{
            background: `linear-gradient(135deg, ${addressToColor(identity.address, 0)} 0%, ${addressToColor(identity.address, 10)} 100%)`,
          }}
        />
      )}

      {/* Info */}
      <div className="space-y-2 min-w-0">
        <h1 className="text-3xl font-semibold tracking-tight truncate">
          {identity.displayName}
        </h1>
        {identity.ensName && (
          <p className="font-mono text-xs text-gray-400">
            {identity.address.slice(0, 6)}...{identity.address.slice(-4)}
          </p>
        )}
        <div className="flex items-center gap-4 text-sm text-gray-500">
          <span>
            <strong className="text-black">{totalWorks}</strong>{" "}
            {totalWorks === 1 ? "work" : "works"} on Foundation
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          <a
            href={`https://evm.now/address/${identity.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
          >
            evm.now ↗
          </a>
        </div>
      </div>
    </div>
  )
}

/** Generate a deterministic color from an Ethereum address. */
function addressToColor(address: string, offset: number): string {
  const hex = address.slice(2, 8 + offset)
  const num = parseInt(hex, 16)
  const h = num % 360
  return `hsl(${h}, 60%, 70%)`
}
