"use client"

// Resolves an address to its mainnet ENS name for display, falling back to a
// shortened address when no name resolves (or the lookup fails/is unavailable).
// Renders bare — no link wrapper, the caller decides whether to wrap it.

import {useEnsName} from "wagmi"
import {mainnet} from "viem/chains"
import {shortAddress} from "@/lib/collection"

export function ArtistName({address, className}: {address: `0x${string}`; className?: string}) {
  const {data: ensName} = useEnsName({address, chainId: mainnet.id})
  return <span className={className}>{ensName ?? shortAddress(address)}</span>
}
