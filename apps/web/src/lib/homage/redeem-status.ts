"use client"

// Live redeem gate for a HomageMinter: the escrow amount (threshold) and the
// redeem-open timestamp (redeemOpensAt) are both owner-tunable, so neither can
// be hardcoded in UI copy — see contracts.ts's note on the mint-side threshold
// drift (50,000 → 30,000 → 20,000) for why this bit the mint UI once already.
// Shared by HomageRedeem.tsx and HomageRedeemPanel.tsx so the live read and
// the lock check live in one place instead of two.

import {formatEther, type Address} from "viem"
import {useReadContracts} from "wagmi"
import {PREFERRED_CHAIN, useChainNowSec} from "@/components/tx/tx-ui"
import {homageMinterAbi} from "./contracts"

export type HomageRedeemStatus = {
  threshold: bigint | null
  opensAt: bigint | null
  isOpen: boolean
  loading: boolean
  nowSec: number
}

export function useHomageRedeemStatus(minter: Address | undefined): HomageRedeemStatus {
  const nowSec = useChainNowSec()
  const reads = useReadContracts({
    contracts: [
      {address: minter, abi: homageMinterAbi, functionName: "threshold", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "redeemOpensAt", chainId: PREFERRED_CHAIN.id},
    ],
    query: {enabled: !!minter},
  })

  const threshold = reads.data?.[0]?.status === "success" ? (reads.data[0].result as bigint) : null
  const opensAt = reads.data?.[1]?.status === "success" ? (reads.data[1].result as bigint) : null
  // Loading (or chain time not yet resolved) is distinct from "confirmed
  // locked" — callers should show a neutral state, not a false lock notice.
  const loading = opensAt === null || nowSec === 0
  const isOpen = loading ? false : nowSec >= Number(opensAt)

  return {threshold, opensAt, isOpen, loading, nowSec}
}

/** A wei-denominated bigint as a comma-grouped, trailing-zero-trimmed decimal
 *  string (20000000000000000000000n → "20,000"; 1000000000000000n → "0.001"). */
export function formatTokenAmount(v: bigint): string {
  return Number(formatEther(v)).toLocaleString(undefined, {maximumFractionDigits: 6})
}

export function formatLocalTime(ts: bigint): string {
  return new Date(Number(ts) * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
}
