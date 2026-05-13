"use client"

import { useState } from "react"
import { AuctionTermsForm } from "./AuctionTermsForm"
import { TxLink } from "./tx"

/**
 * Modal wrapper around <AuctionTermsForm>. Used from token detail pages where
 * the (contract, tokenId) is already known. The /auction/new page renders
 * <AuctionTermsForm> inline instead — same on-chain flow, no chrome.
 *
 * Props:
 *   houseAddress  — the artist's deployed auction house
 *   nftContract   — the ERC721 contract holding the token
 *   tokenId       — token ID to auction
 *   tokenTitle    — optional display name shown in the header
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
  const [createdHash, setCreatedHash] = useState<`0x${string}` | null>(null)

  function handleSuccess(hash: `0x${string}`) {
    setCreatedHash(hash)
    if (onSuccess) onSuccess()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-surface rounded-lg shadow-xl overflow-hidden"
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

        {createdHash ? (
          <div className="px-5 py-6 space-y-4">
            <div className="rounded border border-emerald-200 bg-emerald-50 p-3 space-y-2">
              <p className="text-sm font-medium text-emerald-900">
                Auction created ✓
              </p>
              <TxLink hash={createdHash} label="Create tx:" />
            </div>
            <button
              onClick={() => {
                onClose()
                // Reload so the auction panel renders on the token page (or
                // the gallery refreshes its state). Closing alone wouldn't
                // refetch SSR'd auction data.
                window.location.reload()
              }}
              className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="px-5 py-5">
            <AuctionTermsForm
              houseAddress={houseAddress}
              nftContract={nftContract}
              tokenId={tokenId}
              onSuccess={handleSuccess}
            />
          </div>
        )}
      </div>
    </div>
  )
}
