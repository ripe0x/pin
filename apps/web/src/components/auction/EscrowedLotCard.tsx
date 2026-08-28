"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { sovereignAuctionHouseV2Abi } from "@pin/abi"
import { formatWriteError } from "@/components/tx/tx-ui"
import { TxLink } from "./tx"

/**
 * Escrowed-settlement card for a V2 auction. The sale is complete (seller
 * and protocol paid); the lot is held by the house for delivery only to
 * the recorded winner. claimEscrowedLot is permissionless and retryable,
 * so anyone can push the delivery once the winner's account can receive.
 */
export function EscrowedLotCard({
  houseAddress,
  auctionId,
  winnerDisplay,
}: {
  houseAddress: `0x${string}`
  auctionId: string
  winnerDisplay: string
}) {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const { writeContract, data: txHash, isPending, error } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  useEffect(() => {
    if (isSuccess) router.refresh()
  }, [isSuccess, router])

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          Sold, delivery pending
        </span>
      </div>
      <p className="text-xs font-mono text-gray-500">
        The sale settled and the seller was paid. The lot is held by the
        house for {winnerDisplay} because their wallet could not receive it
        at settlement. Anyone can deliver it once the winner's wallet can
        accept the transfer.
      </p>
      {mounted && (
        <>
          <button
            onClick={() =>
              writeContract({
                address: houseAddress,
                abi: sovereignAuctionHouseV2Abi,
                functionName: "claimEscrowedLot",
                args: [BigInt(auctionId)],
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
                  : "Deliver lot to winner"}
          </button>
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
