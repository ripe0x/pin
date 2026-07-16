"use client"

// Redeem panel — burn a homage you hold to reclaim the THRESHOLD $111 escrowed inside
// it, paying the live exitFee. Lists the connected wallet's homages (Transfer scan +
// live ownerOf) and issues redeem(punkId) per row.

import {useEffect, useState} from "react"
import {formatEther, type Address} from "viem"
import {useWaitForTransactionReceipt, useWriteContract} from "wagmi"
import {PREFERRED_CHAIN, TxSuccessBanner, formatWriteError} from "@/components/tx/tx-ui"
import {homageFlows} from "@/lib/homage/contracts"
import {useOwnedHomages} from "@/lib/homage/punks"

export function HomageRedeem({
  minter,
  collection,
  address,
  exitFee,
  refreshKey,
  onRedeemed,
}: {
  minter: Address
  collection: Address
  address: Address
  exitFee: bigint
  refreshKey: number
  onRedeemed: () => void
}) {
  const [localKey, setLocalKey] = useState(0)
  const {ids, status} = useOwnedHomages(collection, address, refreshKey + localKey)
  const flows = homageFlows(minter)

  const {writeContract, data: txHash, isPending: isWritePending, error: writeError, reset} = useWriteContract()
  const {isLoading: isTxPending, isSuccess} = useWaitForTransactionReceipt({hash: txHash})
  const isPending = isWritePending || isTxPending
  const [pendingId, setPendingId] = useState<number | null>(null)

  useEffect(() => {
    if (isSuccess) {
      onRedeemed()
      setLocalKey((k) => k + 1)
      setPendingId(null)
    }
  }, [isSuccess, onRedeemed])

  if (ids.length === 0 && status !== "loading") return null

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">Your homages · redeem</p>
        <span className="text-[10px] font-mono text-gray-400">exit fee {formatEther(exitFee)} ETH</span>
      </div>
      <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
        Redeeming burns the piece and returns the 50,000 $111 escrowed inside it.
      </p>

      {isSuccess && txHash ? (
        <TxSuccessBanner
          txHash={txHash}
          chainId={PREFERRED_CHAIN.id}
          message="Redeemed. The escrowed $111 is back in your wallet."
          onDismiss={() => reset()}
        />
      ) : (
        <ul className="space-y-2">
          {ids.map((id) => (
            <li key={id} className="flex items-center justify-between gap-3 rounded border border-gray-200 bg-surface-muted/40 px-3 py-2">
              <span className="text-[11px] font-mono text-fg">Punk #{id}</span>
              <button
                onClick={() => {
                  setPendingId(id)
                  writeContract({...flows.redeem(BigInt(id), exitFee), chainId: PREFERRED_CHAIN.id})
                }}
                disabled={isPending}
                className="text-[10px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 border border-gray-300 text-fg hover:bg-surface-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isPending && pendingId === id ? "Redeeming…" : "Redeem"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {writeError && <p className="text-[10px] font-mono text-status-sold leading-relaxed">{formatWriteError(writeError, "redeem")}</p>}
    </div>
  )
}
