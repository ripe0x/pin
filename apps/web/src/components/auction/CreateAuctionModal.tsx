"use client"

import { useEffect, useMemo, useState } from "react"
import { parseEther } from "viem"
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { erc721Abi, pndAuctionHouseAbi } from "@pin/abi"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const DURATION_OPTIONS = [
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "3 days", seconds: 3 * 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const

/**
 * Two-step create flow:
 *   1. Approve the auction house to transfer this NFT (skipped if already approved).
 *   2. Call createAuction with reserve + duration.
 *
 * Props:
 *   houseAddress  — the artist's deployed auction house
 *   nftContract   — the ERC721 contract holding the token
 *   tokenId       — token ID to auction
 *   onClose       — called when the user dismisses the modal
 *   onSuccess     — called after the createAuction tx confirms
 */
export function CreateAuctionModal({
  houseAddress,
  nftContract,
  tokenId,
  tokenTitle,
  onClose,
  onSuccess,
}: {
  houseAddress: `0x${string}`
  nftContract: `0x${string}`
  tokenId: string
  tokenTitle?: string
  onClose: () => void
  onSuccess?: () => void
}) {
  const { address } = useAccount()
  const [reserveInput, setReserveInput] = useState("")
  const [durationSec, setDurationSec] = useState<number>(DURATION_OPTIONS[0].seconds)

  // Check existing approval state. Two ways: per-token getApproved OR
  // setApprovalForAll on the operator. We only check the operator approval
  // because that's the cheaper-to-keep path for repeat auctions.
  const { data: isApprovedForAll, refetch: refetchApproval } = useReadContract({
    address: nftContract,
    abi: erc721Abi,
    functionName: "isApprovedForAll",
    args: address ? [address, houseAddress] : undefined,
    query: { enabled: !!address },
  })

  // Approve tx
  const {
    writeContract: writeApprove,
    data: approveHash,
    isPending: isApprovePending,
    error: approveError,
  } = useWriteContract()
  const { isLoading: isApproveMining, isSuccess: isApproveSuccess } =
    useWaitForTransactionReceipt({ hash: approveHash })
  useEffect(() => {
    if (isApproveSuccess) refetchApproval()
  }, [isApproveSuccess, refetchApproval])

  // Create tx
  const {
    writeContract: writeCreate,
    data: createHash,
    isPending: isCreatePending,
    error: createError,
  } = useWriteContract()
  const { isLoading: isCreateMining, isSuccess: isCreateSuccess } =
    useWaitForTransactionReceipt({ hash: createHash })
  useEffect(() => {
    if (isCreateSuccess && onSuccess) onSuccess()
  }, [isCreateSuccess, onSuccess])

  const reserveValid = useMemo(() => {
    if (!reserveInput.trim()) return false
    try {
      const v = parseEther(reserveInput.trim() as `${number}`)
      return v > 0n
    } catch {
      return false
    }
  }, [reserveInput])

  function handleApprove() {
    writeApprove({
      address: nftContract,
      abi: erc721Abi,
      functionName: "setApprovalForAll",
      args: [houseAddress, true],
    })
  }

  function handleCreate() {
    if (!reserveValid) return
    writeCreate({
      address: houseAddress,
      abi: pndAuctionHouseAbi,
      functionName: "createAuction",
      args: [
        BigInt(tokenId),
        nftContract,
        BigInt(durationSec),
        parseEther(reserveInput.trim() as `${number}`),
        ZERO_ADDRESS as `0x${string}`, // no curator
        0, // no curator fee
      ],
    })
  }

  const needsApproval = !isApprovedForAll
  const approveBusy = isApprovePending || isApproveMining
  const createBusy = isCreatePending || isCreateMining

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-2 border-b border-gray-100">
          <h2 className="text-lg font-semibold tracking-tight">
            Start an auction
          </h2>
          {tokenTitle && (
            <p className="text-sm text-gray-500 mt-0.5">{tokenTitle}</p>
          )}
        </div>

        {isCreateSuccess ? (
          <div className="px-5 py-6 space-y-4">
            <p className="text-sm text-emerald-700">
              Auction created. Refresh the token page to see it live.
            </p>
            <button
              onClick={onClose}
              className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="px-5 py-5 space-y-5">
            <div className="space-y-2">
              <label className="block">
                <span className="text-xs uppercase tracking-wider text-gray-500">
                  Reserve price
                </span>
                <div className="mt-1 flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors rounded">
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0.5"
                    value={reserveInput}
                    onChange={(e) => setReserveInput(e.target.value)}
                    disabled={createBusy}
                    className="flex-1 px-3 py-2.5 text-base font-medium outline-none disabled:opacity-40 bg-transparent"
                  />
                  <span className="flex items-center px-3 text-sm text-gray-400 border-l border-gray-200">
                    ETH
                  </span>
                </div>
              </label>
              <p className="text-xs text-gray-400">
                Auction starts on the first bid at or above this price.
              </p>
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
                        ? "border-black bg-black text-white"
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
                  className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isApprovePending
                    ? "Confirm in wallet…"
                    : isApproveMining
                      ? "Approving…"
                      : "Approve auction house"}
                </button>
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
                <button
                  onClick={handleCreate}
                  disabled={createBusy || !reserveValid}
                  className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isCreatePending
                    ? "Confirm in wallet…"
                    : isCreateMining
                      ? "Creating auction…"
                      : "Start auction"}
                </button>
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
        )}
      </div>
    </div>
  )
}
