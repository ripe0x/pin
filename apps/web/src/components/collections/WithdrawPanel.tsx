"use client"

/**
 * Pull-payment withdraw panel. Collections accrue mint proceeds (artist share
 * + surface share) to per-address balances; recipients claim them here.
 * Renders only when the connected wallet has something to withdraw, so it is
 * invisible to ordinary viewers and shows up for the artist (or a
 * surface/host) with a pending balance. withdraw(account) is permissionless —
 * anyone can trigger the payout to `account`, they just can't redirect it.
 */

import { formatEther } from "viem"
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { sovereignCollectionAbi } from "@pin/abi"
import { PREFERRED_CHAIN, TxSuccessBanner, formatWriteError } from "@/components/tx/tx-ui"

export function WithdrawPanel({ collection }: { collection: `0x${string}` }) {
  const { address } = useAccount()
  const { data: pending, refetch } = useReadContract({
    address: collection,
    abi: sovereignCollectionAbi,
    functionName: "pendingWithdrawal",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })
  const { writeContract, data: txHash, isPending: isWritePending, error, reset } =
    useWriteContract()
  const { isLoading: isTxPending, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  const amount = (pending as bigint | undefined) ?? 0n
  const showSuccess = isSuccess && !!txHash
  if (!address || (amount === 0n && !showSuccess)) return null

  const isPendingTx = isWritePending || isTxPending

  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Your earnings
      </h2>
      {showSuccess ? (
        <TxSuccessBanner
          txHash={txHash}
          chainId={PREFERRED_CHAIN.id}
          message="Withdrawn to your wallet."
          onDismiss={() => {
            reset()
            void refetch()
          }}
        />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-surface p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              Available
            </span>
            <span className="text-lg font-mono font-medium tabular-nums">
              {formatEther(amount)} <span className="text-xs text-gray-500">ETH</span>
            </span>
          </div>
          <button
            onClick={() =>
              writeContract({
                address: collection,
                abi: sovereignCollectionAbi,
                functionName: "withdraw",
                args: [address],
              })
            }
            disabled={isPendingTx}
            className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isWritePending ? "Confirm in wallet…" : isTxPending ? "Withdrawing…" : "Withdraw"}
          </button>
          {error && (
            <p className="text-[11px] font-mono text-red-500 break-words">
              {formatWriteError(error, "Withdraw")}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
