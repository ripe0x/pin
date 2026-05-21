"use client"

import { useEffect, useState } from "react"
import { useAccount, useReadContract } from "wagmi"
import { erc721Abi } from "@pin/abi"
import { useArtistHouse } from "./useArtistHouse"
import { CreateAuctionModal } from "./CreateAuctionModal"

/**
 * Start-auction CTA for token detail pages. Renders only when:
 *   - The connected wallet currently owns the token (live ownerOf check)
 *   - That wallet has a deployed sovereign auction house
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

  // Own the section chrome here rather than in the page. The component
  // returns null in every non-owner / pre-mount case, so wrapping the
  // <section> at the page level produced an empty bordered band for every
  // viewer who isn't the current owner. Rendering it here means no band
  // unless the CTA actually has something to show.
  return (
    <section className="py-5 border-b border-gray-100">
      <button
        onClick={() => setShowModal(true)}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 border border-gray-200 hover:border-gray-400 transition-colors"
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
    </section>
  )
}
