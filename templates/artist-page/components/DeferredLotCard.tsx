"use client"

/**
 * Renders the three V2-only auction statuses that follow a failed delivery
 * at settlement: "deferred" (retryable via claimLot), "unwound" (refunded
 * and returned, terminal), and "unwound_return_pending" (refunded, but the
 * lot's return to the seller also failed). In all three, delivery to the
 * winner failed: nobody has been paid the sale proceeds.
 */
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import type { Address } from "viem"
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { sovereignAuctionHouseV2Abi } from "@/lib/abi"
import { ZERO_ADDRESS } from "@/lib/config"
import { displayFor, formatEth } from "@/lib/format"
import type { AuctionStatus } from "@/lib/auctions"

// Mirrors `uint64 public constant PENDING_DELIVERY_TIMEOUT = 30 days;` in
// SovereignAuctionHouseV2.sol. A Solidity constant compiles into the
// bytecode rather than storage, so it is identical across every V2 house
// clone; hardcoding it here avoids an extra read for a value that can't
// change.
const PENDING_DELIVERY_TIMEOUT_SEC = 30 * 24 * 60 * 60

type Props = {
  houseAddress: Address
  auctionId: string
  status: Extract<AuctionStatus, "deferred" | "unwound" | "unwound_return_pending">
  winner: Address | null
  deferredAt: string | null
  refundAmount: string | null
  ensMap?: Map<string, string>
}

export function DeferredLotCard({
  houseAddress,
  auctionId,
  status,
  winner,
  deferredAt,
  refundAmount,
  ensMap,
}: Props) {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const { address: connected } = useAccount()
  const nowSec = useNowSec()
  const isWinner =
    !!connected && !!winner && connected.toLowerCase() === winner.toLowerCase()
  const [redirectTo, setRedirectTo] = useState("")

  const { writeContract, data: txHash, isPending, error } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  useEffect(() => {
    if (isSuccess) router.refresh()
  }, [isSuccess, router])

  const winnerDisplay = winner ? displayFor(winner, ensMap) : "the winner"

  if (status === "unwound") {
    return (
      <Card dot="bg-gray-400" label="Auction unwound">
        <p className="text-xs font-mono text-gray-500">
          Delivery to {winnerDisplay} could not complete. Nobody was paid: the
          winning bid was refunded
          {refundAmount ? ` (${formatEth(refundAmount)} ETH)` : ""} and the lot
          was returned to the seller.
          {isWinner ? " The refund is available to withdraw below." : ""}
        </p>
        {mounted && isWinner ? (
          <WithdrawRefundButton houseAddress={houseAddress} />
        ) : null}
      </Card>
    )
  }

  const deferredAtSec = deferredAt ? Number(deferredAt) : null
  const canUnwind =
    // Contract gate is `block.timestamp <= deferredAt + timeout` reverts, so
    // the first valid second is timeout + 1.
    deferredAtSec != null && nowSec > deferredAtSec + PENDING_DELIVERY_TIMEOUT_SEC

  if (status === "unwound_return_pending") {
    return (
      <Card dot="bg-amber-400" label="Unwound, return pending">
        <p className="text-xs font-mono text-gray-500">
          The sale unwound: {winnerDisplay}&rsquo;s bid was refunded.
          Returning the lot to the seller also failed, so it stays locked
          here until the return is retried. Anyone can retry.
        </p>
        {isWinner ? (
          <p className="text-xs font-mono text-gray-500">
            The refund is available to withdraw below.
          </p>
        ) : null}
        {mounted && (
          <>
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
                    ? "Returned"
                    : "Retry return to seller"}
            </button>
            {error ? <ErrorLine error={error} /> : null}
            {isWinner ? <WithdrawRefundButton houseAddress={houseAddress} /> : null}
          </>
        )}
      </Card>
    )
  }

  // status === "deferred"
  return (
    <Card dot="bg-amber-400" label="Delivery deferred">
      <p className="text-xs font-mono text-gray-500">
        Delivery to {winnerDisplay} failed at settlement. Nobody has been
        paid yet; the bid and the lot both stay locked here. Anyone can retry
        delivery. If it keeps failing, unwinding refunds {winnerDisplay}&rsquo;s
        bid in full and returns the lot to the seller.
      </p>

      {mounted && (
        <>
          <button
            onClick={() =>
              writeContract({
                address: houseAddress,
                abi: sovereignAuctionHouseV2Abi,
                functionName: "claimLot",
                args: [BigInt(auctionId), ZERO_ADDRESS],
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
                  ? "Delivered"
                  : "Retry delivery to winner"}
          </button>

          {isWinner ? (
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
                      args: [BigInt(auctionId), redirectTo as Address],
                    })
                  }
                  disabled={
                    isPending ||
                    isMining ||
                    isSuccess ||
                    !/^0x[0-9a-fA-F]{40}$/.test(redirectTo)
                  }
                  className="text-[11px] font-mono uppercase tracking-wider px-3 border border-gray-300 hover:border-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Redirect
                </button>
              </div>
            </div>
          ) : null}

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
            {canUnwind
              ? "Unwind sale (refund winner, return lot)"
              : "Unwind available after 30 days"}
          </button>

          {error ? <ErrorLine error={error} /> : null}
        </>
      )}
    </Card>
  )
}

function WithdrawRefundButton({ houseAddress }: { houseAddress: Address }) {
  const { writeContract, data: txHash, isPending, error } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })
  return (
    <div className="pt-1">
      <button
        onClick={() =>
          writeContract({
            address: houseAddress,
            abi: sovereignAuctionHouseV2Abi,
            functionName: "withdrawRefund",
          })
        }
        disabled={isPending || isMining || isSuccess}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-80 transition-opacity"
      >
        {isPending
          ? "Confirm in wallet…"
          : isMining
            ? "Withdrawing…"
            : isSuccess
              ? "Withdrawn"
              : "Withdraw refund"}
      </button>
      {error ? <ErrorLine error={error} /> : null}
    </div>
  )
}

function Card({
  dot,
  label,
  children,
}: {
  dot: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          {label}
        </span>
      </div>
      {children}
    </div>
  )
}

function ErrorLine({ error }: { error: Error }) {
  const msg = (error.message ?? "").split("\n")[0]
  return (
    <p className="text-[11px] font-mono text-status-sold" role="alert">
      {msg || "Transaction failed."}
    </p>
  )
}

function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}
