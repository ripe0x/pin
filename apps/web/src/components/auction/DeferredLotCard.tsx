"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAccount, useConfig, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { simulateContract } from "wagmi/actions"
import { sovereignAuctionHouseV2Abi } from "@pin/abi"
import { PREFERRED_CHAIN, formatWriteError, useChainNowSec } from "@/components/tx/tx-ui"
import {
  claimRecipientError,
  winnerCodeNote,
  type AccountCodeKind,
} from "@/lib/auction-policy"
import { formatEthAmount } from "@/lib/format-eth"
import { usePreflight } from "@/lib/use-preflight"
import { TxLink } from "./tx"

// Mirrors `uint64 public constant PENDING_DELIVERY_TIMEOUT = 30 days;` in
// SovereignAuctionHouseV2.sol (and V2_1.sol). A Solidity `constant`
// compiles into the bytecode rather than storage, so it is identical
// across every V2 and V2.1 house clone; hardcoding it here avoids an extra
// read for a value that cannot change.
const PENDING_DELIVERY_TIMEOUT_SEC = 30 * 24 * 60 * 60

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

// The three house writes this card makes. V2.1 shares V2's ABI for all of
// them, so one ABI serves both house generations.
type HouseCall =
  | { functionName: "claimLot"; args: readonly [bigint, `0x${string}`] }
  | { functionName: "unwindStuckLot"; args: readonly [bigint] }
  | { functionName: "returnUnwoundLot"; args: readonly [bigint] }

export type DeferredLotStatus =
  | "deferred"
  | "unwound"
  | "unwound_return_pending"
  | "held_for_winner"

/**
 * Renders the V2-family auction statuses where the lot has not reached
 * the winner the normal way:
 *
 *   - "deferred": delivery failed at settlement and nobody has been paid;
 *     awaiting a retry (claimLot) or, after 30 days, an unwind.
 *   - "unwound": the sale unwound (winner refunded, lot returned).
 *   - "unwound_return_pending": unwound, but the lot's return to the
 *     seller also failed.
 *   - "held_for_winner" (V2.1 houses only): the sale is complete and the
 *     seller has been paid, but delivery to the winner's address failed
 *     while the lot itself can still move, so the house holds the lot for
 *     the winner, who claims it to any address with claimLot(id, to).
 *     There is no deadline and no unwind.
 *
 * Every write is simulated from the connected account on PREFERRED_CHAIN
 * first, so a call that would revert (a recipient that also refuses the
 * lot, an unwind that is still too early) shows its reason inline instead
 * of opening the wallet. The simulated request (chainId pinned) is what
 * gets signed.
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
  winnerCodeKind = null,
  houseIsV2_1 = false,
  salePriceWei = null,
}: {
  houseAddress: `0x${string}`
  auctionId: string
  status: DeferredLotStatus
  winner: `0x${string}` | null
  winnerDisplay: string
  sellerDisplay: string
  deferredAtTime: number | null
  refundAmount: bigint | null
  /**
   * Whether the winner address has code (a contract, or an EIP-7702
   * delegated account), read once server-side for deferred and held lots.
   * Such an account runs its own code on delivery, which is the usual
   * reason a delivery fails. Null when unknown or not read.
   */
  winnerCodeKind?: AccountCodeKind | null
  /**
   * V2.1 house. A deferred lot there can be re-checked at any time:
   * unwindStuckLot retries the winner, then settles the sale for the
   * winner if the lot can now move, and only refunds after 30 days.
   */
  houseIsV2_1?: boolean
  /** Hammer price of a held lot (the seller was paid from it). */
  salePriceWei?: bigint | null
}) {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const { address: connected } = useAccount()
  const config = useConfig()
  const preflight = usePreflight()
  const nowSec = useChainNowSec()
  const isWinner = !!connected && !!winner && connected.toLowerCase() === winner.toLowerCase()
  const [redirectTo, setRedirectTo] = useState("")

  const { writeContract, data: txHash, isPending: isWritePending, error, reset } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })
  const isPending = isWritePending || preflight.checking

  useEffect(() => {
    if (isSuccess) router.refresh()
  }, [isSuccess, router])

  function send(call: HouseCall) {
    if (!connected) return
    reset()
    const base = {
      account: connected,
      chainId: PREFERRED_CHAIN.id,
      address: houseAddress,
      abi: sovereignAuctionHouseV2Abi,
    } as const
    void preflight.run(async () => {
      if (call.functionName === "claimLot") {
        const { request } = await simulateContract(config, {
          ...base,
          functionName: "claimLot",
          args: call.args,
        })
        writeContract(request)
      } else if (call.functionName === "unwindStuckLot") {
        const { request } = await simulateContract(config, {
          ...base,
          functionName: "unwindStuckLot",
          args: call.args,
        })
        writeContract(request)
      } else {
        const { request } = await simulateContract(config, {
          ...base,
          functionName: "returnUnwoundLot",
          args: call.args,
        })
        writeContract(request)
      }
    })
  }

  const busy = isPending || isMining || isSuccess
  const redirectError = redirectTo.trim() === "" ? null : claimRecipientError(redirectTo.trim(), houseAddress)
  const redirectValid = redirectTo.trim() !== "" && redirectError === null
  const txError = preflight.error ?? error

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

  const footer = (
    <>
      {txHash && isMining && <TxLink hash={txHash} label="Pending tx:" />}
      {!!txError && (
        <p className="text-[11px] font-mono text-red-500 break-words">
          {formatWriteError(txError, status === "held_for_winner" ? "Claim" : "Delivery")}
        </p>
      )}
    </>
  )

  const redirectField = (label: string, submitLabel: string) => (
    <div className="space-y-2 pt-1 border-t border-gray-100">
      <label className="block text-[10px] font-mono uppercase tracking-wider text-gray-400">
        {label}
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
          onClick={() => send({ functionName: "claimLot", args: [BigInt(auctionId), redirectTo.trim() as `0x${string}`] })}
          disabled={busy || !redirectValid}
          className="text-[11px] font-mono uppercase tracking-wider px-3 border border-gray-300 hover:border-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      </div>
      {redirectError && (
        <p className="text-[11px] font-mono text-red-500">{redirectError}</p>
      )}
    </div>
  )

  if (status === "held_for_winner") {
    return (
      <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
            Sold, awaiting the winner&rsquo;s claim
          </span>
        </div>
        <p className="text-xs font-mono text-gray-500">
          The sale is complete
          {salePriceWei != null ? ` at ${formatEthAmount(salePriceWei)} ETH` : ""}
          {" "}and {sellerDisplay} has been paid. Delivery to{" "}
          {winnerDisplay || "the winner"}&rsquo;s address failed, so the
          auction house holds the lot for {winnerDisplay || "the winner"},
          who can claim it to any address. There is no deadline.
        </p>
        {winnerCodeNote(winnerCodeKind) && (
          <p className="text-[11px] font-mono text-gray-500">
            {winnerCodeNote(winnerCodeKind)}
          </p>
        )}

        {mounted && (
          <>
            {isWinner ? (
              <>
                {redirectField(
                  "Claim the lot to an address you control",
                  isPending ? "Checking…" : isMining ? "Claiming…" : isSuccess ? "Claimed ✓" : "Claim",
                )}
                <button
                  onClick={() => send({ functionName: "claimLot", args: [BigInt(auctionId), ZERO_ADDRESS] })}
                  disabled={busy}
                  className="block w-full text-center text-[11px] font-mono uppercase tracking-wider py-2 border border-gray-200 text-gray-500 hover:border-fg hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Retry delivery to my bid address
                </button>
              </>
            ) : (
              <p className="text-[11px] font-mono text-gray-400">
                Only {winnerDisplay || "the winner"} can choose where the lot goes.
              </p>
            )}
            {footer}
          </>
        )}
      </div>
    )
  }

  const timeoutPassed =
    deferredAtTime != null &&
    nowSec > 0 &&
    nowSec >= deferredAtTime + PENDING_DELIVERY_TIMEOUT_SEC
  // V2.1's unwindStuckLot is callable at any time: before the timeout it
  // either delivers, settles for the winner, or reverts UnwindTooEarly
  // (caught by the simulation, so no failed tx is sent).
  const canUnwind = timeoutPassed || houseIsV2_1

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
          Nobody has been paid yet; the bid and the lot both stay locked
          here. Anyone can retry delivery. If it keeps failing, unwinding
          refunds {winnerDisplay || "the winner"}&rsquo;s bid in full and
          returns the lot to {sellerDisplay}.
          {houseIsV2_1 &&
            " On this house, if the lot can move again it settles for the winner instead."}
        </p>
      )}

      {status === "deferred" && winnerCodeNote(winnerCodeKind) && (
        <p className="text-[11px] font-mono text-gray-500">
          {winnerCodeNote(winnerCodeKind)}
        </p>
      )}

      {mounted && (
        <>
          {status === "deferred" && (
            <button
              onClick={() => send({ functionName: "claimLot", args: [BigInt(auctionId), ZERO_ADDRESS] })}
              disabled={busy || !connected}
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

          {status === "deferred" &&
            isWinner &&
            redirectField("Redirect delivery to a different address (optional, winner only)", "Redirect")}

          {status === "deferred" && (
            <button
              onClick={() => send({ functionName: "unwindStuckLot", args: [BigInt(auctionId)] })}
              disabled={!canUnwind || busy || !connected}
              title={
                canUnwind
                  ? undefined
                  : "Unwinding opens 30 days after delivery first failed."
              }
              className="block w-full text-center text-[11px] font-mono uppercase tracking-wider py-2 border border-gray-200 text-gray-500 hover:border-fg hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {timeoutPassed
                ? "Unwind sale (refund winner, return lot)"
                : houseIsV2_1
                  ? "Re-check lot (settles for the winner if it can move)"
                  : "Unwind available after 30 days"}
            </button>
          )}

          {status === "unwound_return_pending" && (
            <button
              onClick={() => send({ functionName: "returnUnwoundLot", args: [BigInt(auctionId)] })}
              disabled={busy || !connected}
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

          {footer}
        </>
      )}
    </div>
  )
}
