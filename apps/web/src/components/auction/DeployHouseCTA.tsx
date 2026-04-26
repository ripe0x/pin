"use client"

import { useEffect, useState } from "react"
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { pndAuctionHouseFactoryAbi } from "@pin/abi"
import { useArtistHouse } from "./useArtistHouse"
import { AddressLink, TxLink } from "./tx"

/**
 * One-time per-artist CTA: deploys the artist's PND auction house clone via
 * the factory. Renders nothing if the connected wallet is not the artist or
 * if the factory isn't deployed yet. After a successful deploy it shows a
 * confirmation card with the new contract address + tx link until the user
 * acknowledges it.
 */
export function DeployHouseCTA({ artistAddress }: { artistAddress: string }) {
  const { address: connected } = useAccount()
  const isArtist =
    !!connected && connected.toLowerCase() === artistAddress.toLowerCase()

  const { factoryAddress, houseAddress, refetch } = useArtistHouse(artistAddress)
  const [acknowledged, setAcknowledged] = useState(false)

  const { writeContract, data: txHash, isPending, error, reset } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  // Refetch the house address as soon as the deploy tx confirms so the success
  // card can show the new contract address.
  useEffect(() => {
    if (isSuccess) refetch()
  }, [isSuccess, refetch])

  if (!isArtist) return null
  if (!factoryAddress) return null

  // Show success state right after deploy so the user sees what happened.
  if (isSuccess && houseAddress && txHash && !acknowledged) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 space-y-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-emerald-900">
            Auction house deployed ✓
          </h3>
          <p className="text-sm text-emerald-800/80 mt-1">
            Your auction contract is live. You can now start auctions on
            tokens you own.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <AddressLink address={houseAddress} label="Contract:" />
          <TxLink hash={txHash} label="Deploy tx:" />
        </div>
        <button
          onClick={() => {
            setAcknowledged(true)
            reset()
          }}
          className="text-xs font-medium text-emerald-900 hover:underline"
        >
          Continue →
        </button>
      </div>
    )
  }

  // Standard "no house yet" state — already-deployed artists hit this branch's
  // early-out below.
  if (houseAddress) return null

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

  const busy = isPending || isMining

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
        disabled={busy}
        className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isPending
          ? "Confirm in wallet…"
          : isMining
            ? "Deploying…"
            : "Deploy auction house"}
      </button>
      {txHash && isMining && (
        <TxLink hash={txHash} label="Pending tx:" />
      )}
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
