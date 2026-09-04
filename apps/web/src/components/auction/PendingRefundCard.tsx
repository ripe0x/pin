"use client"

import { useEffect, useState } from "react"
import { isAddress, type Address } from "viem"
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { sovereignAuctionHouseAbi, sovereignAuctionHouseV2Abi } from "@pin/abi"
import {
  PREFERRED_CHAIN,
  formatWriteError,
  TxSuccessBanner,
} from "@/components/tx/tx-ui"
import { formatEthAmount } from "@/lib/format-eth"

/**
 * Withdraws the connected wallet's `pendingRefunds` balance on a Sovereign
 * house. That balance accumulates from an outbid refund, an unwound sale's
 * winner refund, or a payout credited here instead of pushed because the
 * recipient is a contract. Renders nothing while disconnected or while the
 * balance is zero. `withdrawRefundTo` (send to a different address) only
 * exists on V2 houses.
 */
export function PendingRefundCard({
  houseAddress,
  houseVersion,
}: {
  houseAddress: `0x${string}`
  houseVersion: 1 | 2
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <Card houseAddress={houseAddress} houseVersion={houseVersion} />
}

function Card({
  houseAddress,
  houseVersion,
}: {
  houseAddress: `0x${string}`
  houseVersion: 1 | 2
}) {
  const { address: connected } = useAccount()
  const abi = houseVersion === 2 ? sovereignAuctionHouseV2Abi : sovereignAuctionHouseAbi

  const { data: pending, refetch } = useReadContract({
    address: houseAddress,
    abi,
    functionName: "pendingRefunds",
    args: connected ? [connected] : undefined,
    query: { enabled: !!connected },
  })

  const [showRedirect, setShowRedirect] = useState(false)
  const [redirectTo, setRedirectTo] = useState("")

  const { writeContract, data: txHash, isPending, error, reset } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  useEffect(() => {
    if (isSuccess) refetch()
  }, [isSuccess, refetch])

  const amount = (pending as bigint | undefined) ?? 0n
  if (!connected || amount === 0n) return null

  const busy = isPending || isMining

  function handleWithdraw() {
    writeContract({
      address: houseAddress,
      abi,
      functionName: "withdrawRefund",
      args: [],
    })
  }

  function handleWithdrawTo() {
    if (!isAddress(redirectTo)) return
    writeContract({
      address: houseAddress,
      abi: sovereignAuctionHouseV2Abi,
      functionName: "withdrawRefundTo",
      args: [redirectTo as Address],
    })
  }

  if (isSuccess && txHash) {
    return (
      <div className="rounded-lg border border-gray-200 bg-surface p-5">
        <TxSuccessBanner
          txHash={txHash}
          chainId={PREFERRED_CHAIN.id}
          message="Refund withdrawn."
          onDismiss={reset}
        />
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Refund available</h3>
        <p className="text-[11px] font-mono text-gray-500 mt-0.5">
          {formatEthAmount(amount)} ETH, from an outbid refund, an unwound
          sale, or a payout credited here because the recipient is a
          contract.
        </p>
      </div>

      <button
        onClick={handleWithdraw}
        disabled={busy}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isPending ? "Confirm in wallet…" : isMining ? "Withdrawing…" : "Withdraw"}
      </button>

      {houseVersion === 2 && (
        <div className="space-y-2 pt-1 border-t border-gray-100">
          {showRedirect ? (
            <div className="space-y-2">
              <label className="block text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Send to a different address
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={redirectTo}
                  onChange={(e) => setRedirectTo(e.target.value.trim())}
                  placeholder="0x…"
                  disabled={busy}
                  className="flex-1 text-xs font-mono border border-gray-300 px-2 py-1.5 disabled:opacity-40"
                />
                <button
                  onClick={handleWithdrawTo}
                  disabled={busy || !isAddress(redirectTo)}
                  className="text-[11px] font-mono uppercase tracking-wider px-3 border border-gray-300 hover:border-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowRedirect(true)}
              disabled={busy}
              className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors disabled:opacity-40"
            >
              Send to a different address
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="text-[11px] font-mono text-red-500 break-words">
          {formatWriteError(error, "Withdraw")}
        </p>
      )}
    </div>
  )
}
