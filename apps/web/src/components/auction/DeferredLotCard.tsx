"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { sovereignAuctionHouseV2Abi } from "@pin/abi"
import { formatWriteError, useChainNowSec } from "@/components/tx/tx-ui"
import { formatEthAmount } from "@/lib/format-eth"
import { TxLink } from "./tx"

// Mirrors `uint64 public constant PENDING_DELIVERY_TIMEOUT = 30 days;` in
// SovereignAuctionHouseV2.sol. A Solidity `constant` compiles into the
// bytecode rather than storage, so it is identical across every V2 house
// clone; hardcoding it here avoids an extra read for a value that cannot
// change.
const PENDING_DELIVERY_TIMEOUT_SEC = 30 * 24 * 60 * 60

/**
 * Renders the three non-active-non-settled-non-cancelled V2 auction
 * statuses: a failed delivery still awaiting a retry ("deferred"), an
 * unwound sale ("unwound"), and an unwound sale whose lot return to the
 * seller itself failed ("unwound_return_pending"). In all three, delivery
 * to the winner failed at settlement — nobody has been paid.
 */
export function DeferredLotCard({
  houseAddress,
  auctionId,
  status,
  winner,
  winnerDisplay,
  sellerDisplay,
  deferredAtTime,
  refundAmount,
}: {
  houseAddress: `0x${string}`
  auctionId: string
  status: "deferred" | "unwound" | "unwound_return_pending"
  winner: `0x${string}` | null
  winnerDisplay: string
  sellerDisplay: string
  deferredAtTime: number | null
  refundAmount: bigint | null
}) {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const { address: connected } = useAccount()
  const nowSec = useChainNowSec()
  const isWinner = !!connected && !!winner && connected.toLowerCase() === winner.toLowerCase()
  const [redirectTo, setRedirectTo] = useState("")

  const { writeContract, data: txHash, isPending, error } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  useEffect(() => {
    if (isSuccess) router.refresh()
  }, [isSuccess, router])

  if (status === "unwound") {
    return (
      <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-2">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-400" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
            Auction unwound
          </span>
        </div>
        <p className="text-xs font-mono text-gray-500">
          Delivery to {winnerDisplay || "the winner"} could not complete.
          Nobody was paid: the winning bid was refunded
          {refundAmount != null ? ` (${formatEthAmount(refundAmount)} ETH)` : ""} and
          the lot was returned to {sellerDisplay}.
          {isWinner && " The refund is available to withdraw below."}
        </p>
      </div>
    )
  }

  const canUnwind =
    deferredAtTime != null &&
    nowSec > 0 &&
    nowSec >= deferredAtTime + PENDING_DELIVERY_TIMEOUT_SEC

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          {status === "unwound_return_pending" ? "Unwound, return pending" : "Delivery deferred"}
        </span>
      </div>

      {status === "unwound_return_pending" ? (
        <p className="text-xs font-mono text-gray-500">
          The sale unwound: {winnerDisplay || "the winner"}&rsquo;s bid was
          refunded. Returning the lot to {sellerDisplay} also failed, so it
          stays locked here until the return is retried. Anyone can retry.
        </p>
      ) : (
        <p className="text-xs font-mono text-gray-500">
          Delivery to {winnerDisplay || "the winner"} failed at settlement.
          Nobody has been paid yet — the bid and the lot both stay locked
          here. Anyone can retry delivery. If it keeps failing, unwinding
          refunds {winnerDisplay || "the winner"}&rsquo;s bid in full and
          returns the lot to {sellerDisplay}.
        </p>
      )}

      {mounted && (
        <>
          {status === "deferred" && (
            <button
              onClick={() =>
                writeContract({
                  address: houseAddress,
                  abi: sovereignAuctionHouseV2Abi,
                  functionName: "claimLot",
                  args: [BigInt(auctionId), "0x0000000000000000000000000000000000000000"],
                })
              }
              disabled={isPending || isMining || isSuccess}
              className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 border border-gray-300 hover:border-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isPending
                ? "Confirm in wallet…"
                : isMining
                  ? "Delivering…"
                  : isSuccess
                    ? "Delivered ✓"
                    : "Retry delivery to winner"}
            </button>
          )}

          {status === "deferred" && isWinner && (
            <div className="space-y-2 pt-1 border-t border-gray-100">
              <label className="block text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Redirect delivery to a different address (optional, winner only)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={redirectTo}
                  onChange={(e) => setRedirectTo(e.target.value)}
                  placeholder="0x…"
                  className="flex-1 text-xs font-mono border border-gray-300 px-2 py-1.5"
                />
                <button
                  onClick={() =>
                    writeContract({
                      address: houseAddress,
                      abi: sovereignAuctionHouseV2Abi,
                      functionName: "claimLot",
                      args: [BigInt(auctionId), redirectTo as `0x${string}`],
                    })
                  }
                  disabled={
                    isPending || isMining || isSuccess || !/^0x[0-9a-fA-F]{40}$/.test(redirectTo)
                  }
                  className="text-[11px] font-mono uppercase tracking-wider px-3 border border-gray-300 hover:border-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Redirect
                </button>
              </div>
            </div>
          )}

          {status === "deferred" && (
            <button
              onClick={() =>
                writeContract({
                  address: houseAddress,
                  abi: sovereignAuctionHouseV2Abi,
                  functionName: "unwindStuckLot",
                  args: [BigInt(auctionId)],
                })
              }
              disabled={!canUnwind || isPending || isMining || isSuccess}
              title={
                canUnwind
                  ? undefined
                  : "Unwinding opens 30 days after delivery first failed."
              }
              className="block w-full text-center text-[11px] font-mono uppercase tracking-wider py-2 border border-gray-200 text-gray-500 hover:border-fg hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {canUnwind ? "Unwind sale (refund winner, return lot)" : "Unwind available after 30 days"}
            </button>
          )}

          {status === "unwound_return_pending" && (
            <button
              onClick={() =>
                writeContract({
                  address: houseAddress,
                  abi: sovereignAuctionHouseV2Abi,
                  functionName: "returnUnwoundLot",
                  args: [BigInt(auctionId)],
                })
              }
              disabled={isPending || isMining || isSuccess}
              className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 border border-gray-300 hover:border-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isPending
                ? "Confirm in wallet…"
                : isMining
                  ? "Returning…"
                  : isSuccess
                    ? "Returned ✓"
                    : `Retry return to ${sellerDisplay}`}
            </button>
          )}

          {txHash && isMining && <TxLink hash={txHash} label="Pending tx:" />}
          {error && (
            <p className="text-[11px] font-mono text-red-500 break-words">
              {formatWriteError(error, "Delivery")}
            </p>
          )}
        </>
      )}
    </div>
  )
}

