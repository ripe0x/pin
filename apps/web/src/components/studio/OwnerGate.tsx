"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * Wraps the studio content: children render only when the connected
 * wallet matches the studio's address. Disconnected wallets get a
 * connect prompt; mismatched wallets get a quiet refusal with a link
 * to the public profile.
 *
 * Like every owner gate in the app this is presentational only — the
 * data behind the studio is public and the writes are enforced
 * onchain. The gate keeps a collector who follows a studio link from
 * seeing a wall of dead controls, nothing more.
 */
export function OwnerGate({
  address,
  displayName,
  children,
}: {
  address: string
  /** Resolved display name for the refusal copy (ENS or truncated 0x). */
  displayName: string
  children: React.ReactNode
}) {
  // Mount gate: the server (and first client render) always shows the
  // connect prompt, so SSR HTML never contains owner-only UI and
  // hydration can't mismatch. Wallet reconnect flips this right after
  // mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const { address: connected, isConnected } = useAccount()

  const isOwner =
    mounted &&
    isConnected &&
    !!connected &&
    connected.toLowerCase() === address.toLowerCase()

  if (isOwner) return <>{children}</>

  if (mounted && isConnected && connected) {
    return (
      <div className="rounded-lg border border-gray-200 bg-surface p-6 space-y-3">
        <p className="text-sm font-medium">
          This studio belongs to {displayName}.
        </p>
        <p className="text-xs text-gray-500">
          You are connected as {shortAddr(connected)}. Switch to{" "}
          {shortAddr(address)} to manage this work.
        </p>
        <Link
          href={`/artist/${address.toLowerCase()}`}
          className="inline-block text-xs font-medium underline text-gray-700 hover:text-fg"
        >
          View the public page instead
        </Link>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-6 space-y-4">
      <p className="text-sm text-gray-600">
        Connect the wallet that owns this studio to manage listings,
        auctions, your catalog, and your site.
      </p>
      <ConnectButton.Custom>
        {({ openConnectModal }) => (
          <button
            type="button"
            onClick={openConnectModal}
            className="text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors"
          >
            Connect wallet
          </button>
        )}
      </ConnectButton.Custom>
    </div>
  )
}
