"use client"

import { useEffect, useState } from "react"
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { erc721Abi, sovereignAuctionHouseAbi } from "@pin/abi"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import { TxLink } from "./tx"

const DURATION_OPTIONS = [
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "3 days", seconds: 3 * 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const

/**
 * Shared "approve + create" auction form body. Two-step flow:
 *   1. setApprovalForAll(houseAddress, true) on the NFT contract (skipped if already approved).
 *   2. createAuction(tokenId, contract, duration, reserve) on the artist's house.
 *
 * Renders just the form fields + step buttons + tx feedback — no chrome. Used
 * inline on /auction/new and inside the modal wrapper on token detail pages.
 */
export function AuctionTermsForm({
  houseAddress,
  nftContract,
  tokenId,
  onSuccess,
}: {
  houseAddress: `0x${string}`
  nftContract: `0x${string}`
  tokenId: string
  onSuccess?: (createTxHash: `0x${string}`) => void
}) {
  const { address } = useAccount()
  const reserve = useEthAmountInput()
  const [durationSec, setDurationSec] = useState<number>(DURATION_OPTIONS[0].seconds)

  const { data: isApprovedForAll, refetch: refetchApproval } = useReadContract({
    address: nftContract,
    abi: erc721Abi,
    functionName: "isApprovedForAll",
    args: address ? [address, houseAddress] : undefined,
    query: { enabled: !!address },
  })

  const {
    writeContract: writeApprove,
    data: approveHash,
    isPending: isApprovePending,
    error: approveError,
  } = useWriteContract()
  const {
    isLoading: isApproveMining,
    isSuccess: isApproveSuccess,
    data: approveReceipt,
  } = useWaitForTransactionReceipt({ hash: approveHash })
  const approveReverted = approveReceipt?.status === "reverted"
  useEffect(() => {
    if (isApproveSuccess) refetchApproval()
  }, [isApproveSuccess, refetchApproval])

  const {
    writeContract: writeCreate,
    data: createHash,
    isPending: isCreatePending,
    error: createError,
  } = useWriteContract()
  const {
    isLoading: isCreateMining,
    isSuccess: isCreateSuccess,
    data: createReceipt,
  } = useWaitForTransactionReceipt({ hash: createHash })
  const createReverted = createReceipt?.status === "reverted"
  useEffect(() => {
    if (isCreateSuccess && createHash && onSuccess) onSuccess(createHash)
  }, [isCreateSuccess, createHash, onSuccess])

  const reserveValid = reserve.isValid && reserve.wei !== null
  const isNoReserve = reserve.wei === 0n

  function handleApprove() {
    writeApprove({
      address: nftContract,
      abi: erc721Abi,
      functionName: "setApprovalForAll",
      args: [houseAddress, true],
    })
  }

  function handleCreate() {
    if (!reserveValid || reserve.wei == null) return
    writeCreate({
      address: houseAddress,
      abi: sovereignAuctionHouseAbi,
      functionName: "createAuction",
      args: [
        BigInt(tokenId),
        nftContract,
        BigInt(durationSec),
        reserve.wei,
      ],
    })
  }

  const needsApproval = !isApprovedForAll
  const approveBusy = isApprovePending || isApproveMining
  const createBusy = isCreatePending || isCreateMining

  if (isCreateSuccess && createHash) {
    return (
      <div className="space-y-4">
        <div className="rounded border border-emerald-200 bg-emerald-50 p-3 space-y-2">
          <p className="text-sm font-medium text-emerald-900">
            Auction created ✓
          </p>
          <TxLink hash={createHash} label="Create tx:" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">
            Reserve price
          </span>
          <div className="mt-1 flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors rounded">
            <input
              {...reserve.inputProps}
              placeholder="0.5"
              disabled={createBusy}
              className="flex-1 px-3 py-2.5 text-base font-medium outline-none disabled:opacity-40 bg-transparent"
            />
            <span className="flex items-center px-3 text-sm text-gray-400 border-l border-gray-200">
              ETH
            </span>
          </div>
        </label>
        {reserve.error ? (
          <p className="text-xs text-red-500">{reserve.error}</p>
        ) : (
          <p className="text-xs text-gray-400">
            {isNoReserve
              ? "No reserve — any bid wins. Timer starts on first bid."
              : "Auction starts on the first bid at or above this price."}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <span className="text-xs uppercase tracking-wider text-gray-500 block">
          Duration
        </span>
        <div className="grid grid-cols-3 gap-2">
          {DURATION_OPTIONS.map((opt) => (
            <button
              key={opt.seconds}
              onClick={() => setDurationSec(opt.seconds)}
              disabled={createBusy}
              className={`py-2 text-sm border rounded transition-colors ${
                durationSec === opt.seconds
                  ? "border-fg bg-fg text-bg"
                  : "border-gray-200 hover:border-gray-400"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {needsApproval ? (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            Step 1 of 2: approve your auction house to escrow this NFT
            during the auction. One-time per collection.
          </p>
          <button
            onClick={handleApprove}
            disabled={approveBusy}
            className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isApprovePending
              ? "Confirm in wallet…"
              : isApproveMining
                ? "Approving…"
                : "Approve auction house"}
          </button>
          {approveHash && isApproveMining && (
            <TxLink hash={approveHash} label="Pending tx:" />
          )}
          {approveReverted && approveHash && (
            <div className="rounded border border-red-200 bg-red-50 p-2.5 space-y-1">
              <p className="text-xs font-medium text-red-700">
                Approve reverted on-chain
              </p>
              <TxLink hash={approveHash} label="Reverted tx:" />
            </div>
          )}
          {approveError && (
            <p className="text-xs text-red-500 break-words">
              {approveError.message.includes("User rejected")
                ? "Transaction rejected"
                : approveError.message.split("\n")[0]}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {isApproveSuccess && approveHash && (
            <div className="rounded border border-emerald-200 bg-emerald-50 p-2.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-emerald-900">
                Approved ✓
              </span>
              <TxLink hash={approveHash} label="Approve tx:" />
            </div>
          )}
          <button
            onClick={handleCreate}
            disabled={createBusy || !reserveValid}
            className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isCreatePending
              ? "Confirm in wallet…"
              : isCreateMining
                ? "Creating auction…"
                : "Start auction"}
          </button>
          {createHash && isCreateMining && (
            <TxLink hash={createHash} label="Pending tx:" />
          )}
          {createReverted && createHash && (
            <div className="rounded border border-red-200 bg-red-50 p-2.5 space-y-1">
              <p className="text-xs font-medium text-red-700">
                Create reverted on-chain
              </p>
              <p className="text-xs text-red-700/80">
                Likely cause: you don&apos;t own this token, or the house isn&apos;t approved.
              </p>
              <TxLink hash={createHash} label="Reverted tx:" />
            </div>
          )}
          {createError && (
            <p className="text-xs text-red-500 break-words">
              {createError.message.includes("User rejected")
                ? "Transaction rejected"
                : createError.message.split("\n")[0]}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
