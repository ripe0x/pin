"use client"

import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { pndAuctionHouseFactoryAbi } from "@pin/abi"
import { useArtistHouse } from "./useArtistHouse"

/**
 * One-time per-artist CTA: deploys the artist's PND auction house clone via
 * the factory. Renders nothing if the connected wallet is not the artist, if
 * the factory isn't deployed yet, or if a house already exists.
 */
export function DeployHouseCTA({ artistAddress }: { artistAddress: string }) {
  const { address: connected } = useAccount()
  const isArtist =
    !!connected && connected.toLowerCase() === artistAddress.toLowerCase()

  const { factoryAddress, houseAddress, refetch } = useArtistHouse(artistAddress)

  const { writeContract, data: txHash, isPending, error, reset } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  if (!isArtist) return null
  if (!factoryAddress) return null
  if (houseAddress) return null

  if (isSuccess) {
    // Refresh state so the CTA disappears and create-auction options unlock.
    refetch()
    reset()
    return null
  }

  function handleDeploy() {
    if (!factoryAddress || !connected) return
    writeContract({
      address: factoryAddress,
      abi: pndAuctionHouseFactoryAbi,
      functionName: "createAuctionHouse",
      args: [connected],
    })
  }

  if (!connected) {
    return (
      <ConnectButton.Custom>
        {({ openConnectModal }) => (
          <button
            onClick={openConnectModal}
            className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors"
          >
            Connect wallet to set up auctions
          </button>
        )}
      </ConnectButton.Custom>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
      <div>
        <h3 className="text-base font-semibold tracking-tight">
          Set up your auction house
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          One-time deploy of your own PND auction contract. After this you can
          start reserve auctions on any of your tokens directly from this page.
        </p>
      </div>
      <button
        onClick={handleDeploy}
        disabled={isPending || isMining}
        className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isPending
          ? "Confirm in wallet…"
          : isMining
            ? "Deploying…"
            : "Deploy auction house"}
      </button>
      {error && (
        <p className="text-xs text-red-500 break-words">
          {error.message.includes("User rejected")
            ? "Transaction rejected"
            : error.message.split("\n")[0]}
        </p>
      )}
    </div>
  )
}
