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

/**
 * Surface protocol custom errors (contracts/src/surface/interfaces/
 * ISurfaceCore.sol) mapped to human copy. viem decodes a reverted custom error
 * onto `ContractFunctionRevertedError.data.errorName` when it can ABI-decode
 * the revert data; when the RPC doesn't preflight with `eth_call` before
 * broadcast, the same name still shows up literally inside `shortMessage` /
 * `metaMessages` (e.g. "Error: WrongPayment()") — the matcher below checks
 * both.
 */
const COLLECTION_ERROR_COPY: Record<string, string> = {
  WrongPayment: "The price changed since the page loaded. The quote has been refreshed, try again.",
  Underpayment: "The price changed since the page loaded. The quote has been refreshed, try again.",
  ExceedsCap: "Sold out during your transaction. Gas is consumed on failed transactions.",
  MintNotStarted: "The mint window is not open.",
  MintEnded: "The mint window is not open.",
  HookRejected: "This mint has additional onchain conditions that were not met.",
}

/**
 * GateHook custom errors (contracts/src/surface/hooks/GateHook.sol) —
 * selector-identical to AllowlistHook.NotAllowlisted /
 * PerWalletCapHook.WalletCapExceeded, so this same copy applies regardless
 * of which reference hook a collection uses. Decoded the same way as
 * COLLECTION_ERROR_COPY (`data.errorName`, or the name appearing literally
 * in shortMessage/metaMessages when undecoded), so it's folded into the same
 * matching loop below rather than duplicating it.
 */
const HOOK_REVERT_COPY: Record<string, string> = {
  NotAllowlisted: "This wallet is not on the allowlist for this mint.",
  WalletCapExceeded: "This wallet has reached its per-wallet mint limit.",
}

/**
 * Format a wagmi/viem write error for display. viem attaches the actual revert
 * reason on the error's `cause.cause...` chain (and a friendlier `shortMessage`
 * on the top-level error). The default Error.message is a multi-line block
 * whose first line is just "The contract function X reverted with the following
 * reason:" — useless without the next line. Walk the cause chain to find the
 * deepest message that contains the actual on-chain revert string (typically
 * prefixed `<func>::<reason>`).
 */
export function formatWriteError(err: unknown, action: string): string {
  if (!err || typeof err !== "object") return `${action} failed`
  const e = err as {
    message?: string
    shortMessage?: string
    cause?: unknown
    metaMessages?: string[]
  }
  if (e.message?.includes("User rejected")) return "Transaction rejected"
  if (e.message?.includes("insufficient funds")) return "Insufficient ETH balance"

  // Walk the whole cause chain once, collecting every decoded error name and
  // message-shaped string we see, so a known Surface protocol or hook
  // revert maps to plain copy before falling back to the generic
  // deepest-message walk below.
  const seen: string[] = []
  let node: unknown = err
  for (let i = 0; i < 8 && node && typeof node === "object"; i++) {
    const n = node as {
      data?: { errorName?: string }
      reason?: string
      shortMessage?: string
      message?: string
      metaMessages?: string[]
      cause?: unknown
    }
    if (n.data?.errorName) seen.push(n.data.errorName)
    if (n.reason) seen.push(n.reason)
    if (n.shortMessage) seen.push(n.shortMessage)
    if (n.message) seen.push(n.message)
    if (Array.isArray(n.metaMessages)) seen.push(...n.metaMessages)
    node = n.cause
  }
  for (const [name, copy] of Object.entries({ ...COLLECTION_ERROR_COPY, ...HOOK_REVERT_COPY })) {
    const nameBoundary = new RegExp(`\\b${name}\\b`)
    if (seen.some((s) => s === name || nameBoundary.test(s))) return copy
  }

  // Walk cause chain for the deepest shortMessage / reason.
  let deepest: string | undefined = e.shortMessage
  let cur: unknown = e.cause
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const c = cur as { shortMessage?: string; reason?: string; cause?: unknown }
    if (c.shortMessage) deepest = c.shortMessage
    if (c.reason) deepest = c.reason
    cur = c.cause
  }
  // metaMessages often holds the reverted reason as a follow-on line.
  if (!deepest && Array.isArray(e.metaMessages)) {
    const reasonLine = e.metaMessages.find((m) => /::|reverted|require/i.test(m))
    if (reasonLine) deepest = reasonLine.trim()
  }
  if (!deepest) deepest = e.message?.split("\n")[0]
  return `${action} failed: ${deepest ?? "unknown error"}`
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
