"use client"

import { useEffect, useState } from "react"
import { useAccount, useReadContract } from "wagmi"
import { erc721Abi } from "@pin/abi"
import { useArtistHouse } from "./useArtistHouse"
import { CreateAuctionModal } from "./CreateAuctionModal"

/**
 * Start-auction CTA for token detail pages. Renders only when:
 *   - The connected wallet currently owns the token (live ownerOf check)
 *   - That wallet has a deployed PND auction house
 *
 * Caller is responsible for not rendering this when an active auction already
 * exists for the token (the page already gates on `auction === null`).
 */
export function StartAuctionCTA({
  nftContract,
  tokenId,
  tokenTitle,
}: {
  nftContract: `0x${string}`
  tokenId: string
  tokenTitle?: string
}) {
  // Wagmi hooks call useConfig() which throws when WagmiProvider isn't yet in
  // scope during SSR. Render nothing until mount; the inner component runs the
  // hooks safely on the client.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  if (!mounted) return null

  return (
    <StartAuctionCTAClient
      nftContract={nftContract}
      tokenId={tokenId}
      tokenTitle={tokenTitle}
    />
  )
}

function StartAuctionCTAClient({
  nftContract,
  tokenId,
  tokenTitle,
}: {
  nftContract: `0x${string}`
  tokenId: string
  tokenTitle?: string
}) {
  const { address } = useAccount()
  const [showModal, setShowModal] = useState(false)

  const { data: currentOwner } = useReadContract({
    address: nftContract,
    abi: erc721Abi,
    functionName: "ownerOf",
    args: [BigInt(tokenId)],
  })

  const isCurrentOwner =
    !!address &&
    !!currentOwner &&
    address.toLowerCase() === (currentOwner as string).toLowerCase()

  const { houseAddress } = useArtistHouse(address)

  if (!isCurrentOwner || !houseAddress) return null

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="block w-full text-center text-sm font-medium py-3 border border-gray-200 hover:border-gray-400 transition-colors"
      >
        Start auction
      </button>
      {showModal && (
        <CreateAuctionModal
          houseAddress={houseAddress}
          nftContract={nftContract}
          tokenId={tokenId}
          tokenTitle={tokenTitle}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  )
}
