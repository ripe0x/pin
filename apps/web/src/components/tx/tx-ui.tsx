"use client"

/**
 * Shared on-chain-write UI primitives, lifted out of AuctionPanel so the
 * auction flow and the Mint-edition collect flow share one implementation
 * (error formatting, the RPC-frugal chain clock, countdown, success banner).
 *
 * Tx links use evm.now (multi-chain explorer), keyed on the chain the tx was
 * sent on.
 */

import { useEffect, useState } from "react"
import { usePublicClient } from "wagmi"
import { mainnet, sepolia } from "wagmi/chains"
export { formatWriteError } from "@pin/surface-kit"
import { forkChain } from "@/lib/wagmi"

// When the dev server is pointed at a local Anvil fork
// (NEXT_PUBLIC_USE_LOCAL_RPC=1), we're in fork-testing mode and the
// *preferred* chain is foundry — sending txs on real Ethereum mainnet would
// bypass the fork. In production this flag is unset and the preferred chain is
// mainnet. NEXT_PUBLIC_* vars are inlined at build time so this evaluates
// statically per build.
export const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Opt-in sepolia instance (mirrors lib/collection.ts' PND_CHAIN_ID split).
export const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"
// In fork mode the preferred chain is the SAME custom Anvil chain the wagmi
// config registers (forkChain, id 31339), so wrongNetwork checks and
// switchChain targets agree with the connected wallet. (Previously this used
// upstream `foundry` at 31337, which never matched the configured fork chain,
// leaving tx buttons stuck on "wrong network" in local fork testing.)
export const PREFERRED_CHAIN = FORK_MODE ? forkChain : USE_SEPOLIA ? sepolia : mainnet
export const PREFERRED_CHAIN_LABEL = FORK_MODE ? forkChain.name : USE_SEPOLIA ? "Sepolia" : "Ethereum"

/**
 * Tx explorer URL, chain-aware. Mainnet uses evm.now (the project's
 * multi-chain explorer); testnets use the network's own etherscan subdomain
 * — evm.now has no sepolia support.
 */
export function evmNowTxUrl(txHash: string, chainId: number): string {
  if (chainId === sepolia.id) return `https://sepolia.etherscan.io/tx/${txHash}`
  return `https://evm.now/tx/${txHash}?chainId=${chainId}`
}

export function formatRemaining(secondsLeft: number): string {
  if (secondsLeft <= 0) return "Ended"
  const d = Math.floor(secondsLeft / 86400)
  const h = Math.floor((secondsLeft % 86400) / 3600)
  const m = Math.floor((secondsLeft % 3600) / 60)
  const s = secondsLeft % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * Returns the chain time (seconds) for countdown rendering. Reads the latest
 * block ONCE on mount to compute an offset between chain time and wall-clock
 * time, then drives the countdown via `Date.now()` plus that offset. A
 * 1-second `setInterval` triggers re-renders so the countdown ticks visibly.
 *
 * Why not `useBlock({ watch: true })`: that polls `eth_getBlockByNumber` every
 * ~4s per mounted component, dominating total RPC volume on this app. The
 * countdown only needs sub-second visual precision and the write button always
 * reads fresh on-chain state at click time, so polling chain time continuously
 * is pure waste.
 *
 * Why anchor to chain time at all: on a local Anvil fork (`evm_increaseTime`),
 * wall-clock and chain time can diverge by minutes. Reading once on mount
 * catches that for the loaded frame.
 *
 * Returns 0 until the first block read resolves, so callers treat 0 as
 * "unknown — don't make end-state decisions yet".
 */
export function useChainNowSec(): number {
  const client = usePublicClient()
  const [chainOffsetSec, setChainOffsetSec] = useState<number | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!client) return
    let cancelled = false
    void client
      .getBlock()
      .then((block) => {
        if (cancelled) return
        const wallSec = Math.floor(Date.now() / 1000)
        setChainOffsetSec(Number(block.timestamp) - wallSec)
      })
      .catch(() => {
        if (!cancelled) setChainOffsetSec(0)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (chainOffsetSec === null) return 0
  return Math.floor(Date.now() / 1000) + chainOffsetSec
}

export function Countdown({
  endTime,
  nowSec,
}: {
  endTime: bigint
  nowSec: number
}) {
  const secondsLeft = nowSec === 0 ? 0 : Math.max(0, Number(endTime) - nowSec)
  return <span suppressHydrationWarning>{formatRemaining(secondsLeft)}</span>
}

/**
 * Persistent confirmation banner shown after a write tx confirms. Stays visible
 * until the user dismisses (which clears wagmi's success state). Links to the
 * tx on evm.now, keyed on the chain it was sent on.
 */
export function TxSuccessBanner({
  txHash,
  chainId,
  message,
  onDismiss,
}: {
  txHash: `0x${string}`
  chainId: number
  message: string
  onDismiss: () => void
}) {
  return (
    <div className="px-3 py-2 bg-green-50 border border-green-200 text-green-800 text-[11px] font-mono space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span>{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-green-700 hover:text-green-900 leading-none"
        >
          ✕
        </button>
      </div>
      <a
        href={evmNowTxUrl(txHash, chainId)}
        target="_blank"
        rel="noopener noreferrer"
        className="block underline hover:text-green-900 break-all"
      >
        View tx: {txHash.slice(0, 10)}…{txHash.slice(-8)} ↗
      </a>
    </div>
  )
}
