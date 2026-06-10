"use client"

/**
 * Artist controls for their release, shown only to the connected owner.
 * Withdraw proceeds, close the window (one-way), freeze metadata (one-way),
 * repoint the payout. Everything mutable announces itself onchain; nothing
 * here can touch the immutable terms.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { isAddress, type Address } from "viem"
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { releaseAbi } from "@pin/abi"
import { formatWriteError } from "@/components/tx/tx-ui"
import { formatEthAmount } from "@/lib/format-eth"

const BTN_SECONDARY =
  "w-full text-center text-[10px] font-mono uppercase tracking-wider py-2 border border-gray-200 hover:border-gray-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
const INPUT =
  "w-full px-3 py-2 text-xs font-mono bg-surface border border-gray-200 focus:border-gray-400 outline-none transition-colors disabled:opacity-40"

export function ReleaseAdminPanel({
  release,
  owner,
  payout,
  artistBalance,
  closed,
  metadataFrozen,
}: {
  release: Address
  owner: Address
  payout: Address
  artistBalance: string
  closed: boolean
  metadataFrozen: boolean
}) {
  const { address } = useAccount()
  const router = useRouter()
  const [newPayout, setNewPayout] = useState("")

  const tx = useWriteContract()
  const { isLoading: mining, data: receipt } = useWaitForTransactionReceipt({
    hash: tx.data,
  })
  useEffect(() => {
    if (receipt) {
      tx.reset()
      router.refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt])

  if (!address || address.toLowerCase() !== owner.toLowerCase()) return null

  const busy = tx.isPending || mining
  const balance = BigInt(artistBalance)

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-3">
      <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        Your release
      </h2>

      <button
        className={BTN_SECONDARY}
        disabled={busy || balance === 0n}
        onClick={() =>
          tx.writeContract({
            address: release,
            abi: releaseAbi,
            functionName: "withdraw",
          })
        }
      >
        {balance === 0n
          ? "Nothing to withdraw"
          : `Withdraw ${formatEthAmount(balance)} ETH`}
      </button>

      {!closed && (
        <button
          className={BTN_SECONDARY}
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "End minting forever? A closed release can never reopen, and windows can never be extended.",
              )
            ) {
              tx.writeContract({
                address: release,
                abi: releaseAbi,
                functionName: "close",
              })
            }
          }}
        >
          Close release
        </button>
      )}

      {!metadataFrozen && (
        <button
          className={BTN_SECONDARY}
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "Freeze metadata forever? The token URI, renderer, and collection metadata can never change again.",
              )
            ) {
              tx.writeContract({
                address: release,
                abi: releaseAbi,
                functionName: "freezeMetadata",
              })
            }
          }}
        >
          Freeze metadata
        </button>
      )}

      <div className="space-y-2 border-t border-gray-100 pt-3">
        <p className="text-[10px] font-mono text-gray-400">
          Proceeds go to {payout}
        </p>
        <input
          className={INPUT}
          value={newPayout}
          onChange={(e) => setNewPayout(e.target.value.trim())}
          placeholder="0x… new payout address"
          aria-label="New payout address"
          disabled={busy}
        />
        <button
          className={BTN_SECONDARY}
          disabled={busy || !isAddress(newPayout)}
          onClick={() =>
            tx.writeContract({
              address: release,
              abi: releaseAbi,
              functionName: "setPayout",
              args: [newPayout as Address],
            })
          }
        >
          Update payout
        </button>
      </div>

      {tx.error && (
        <p className="text-[11px] font-mono text-red-500 break-words">
          {formatWriteError(tx.error, "Update")}
        </p>
      )}
    </div>
  )
}
