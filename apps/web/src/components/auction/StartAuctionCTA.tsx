"use client"

import { useEffect, useState } from "react"
import { parseAbi } from "viem"
import { useAccount, useReadContract } from "wagmi"
import { erc721Abi } from "@pin/abi"
import { listingBlockReason } from "@/lib/auction-policy"
import { useResolvedArtistHouse } from "./useResolvedArtistHouse"
import { ListingBlockedNotice } from "./ListingBlockedNotice"
import { CreateAuctionModal } from "./CreateAuctionModal"

const erc1155BalanceAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
])

/**
 * Start-auction CTA for token detail pages. Renders only when:
 *   - The connected wallet currently owns the token (live ownerOf check for
 *     ERC721, balanceOf for ERC1155)
 *   - That wallet has a deployed sovereign auction house
 *
 * When lib/auction-policy.ts blocks the listing (a V1 house, or an ERC1155
 * lot while those are paused) the owner sees the reason instead of the
 * button.
 *
 * Caller is responsible for not rendering this when an active auction already
 * exists for the token (the page already gates on `auction === null`).
 */
export function StartAuctionCTA({
  nftContract,
  tokenId,
  tokenTitle,
  tokenStandard = "erc721",
}: {
  nftContract: `0x${string}`
  tokenId: string
  tokenTitle?: string
  tokenStandard?: "erc721" | "erc1155"
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
      tokenStandard={tokenStandard}
    />
  )
}

function StartAuctionCTAClient({
  nftContract,
  tokenId,
  tokenTitle,
  tokenStandard,
}: {
  nftContract: `0x${string}`
  tokenId: string
  tokenTitle?: string
  tokenStandard: "erc721" | "erc1155"
}) {
  const { address } = useAccount()
  const [showModal, setShowModal] = useState(false)
  const is1155 = tokenStandard === "erc1155"

  const { data: currentOwner } = useReadContract({
    address: nftContract,
    abi: erc721Abi,
    functionName: "ownerOf",
    args: [BigInt(tokenId)],
    query: { enabled: !is1155 },
  })
  const { data: balance1155 } = useReadContract({
    address: nftContract,
    abi: erc1155BalanceAbi,
    functionName: "balanceOf",
    args: address ? [address, BigInt(tokenId)] : undefined,
    query: { enabled: is1155 && !!address },
  })

  const isCurrentOwner = is1155
    ? typeof balance1155 === "bigint" && balance1155 > 0n
    : !!address &&
      !!currentOwner &&
      address.toLowerCase() === (currentOwner as string).toLowerCase()

  const { houseAddress, version, isV2_1 } = useResolvedArtistHouse(address)

  if (!isCurrentOwner || !houseAddress) return null
  const blockReason = listingBlockReason(version ?? 1, tokenStandard, isV2_1)
  if (blockReason) {
    return (
      <section className="py-5 border-b border-gray-100">
        <ListingBlockedNotice reason={blockReason} ownerAddress={address} />
      </section>
    )
  }

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
          houseVersion={version ?? 1}
          houseIsV2_1={isV2_1}
          nftContract={nftContract}
          tokenId={tokenId}
          tokenStandard={tokenStandard}
          maxQuantity={is1155 ? balance1155 : undefined}
          tokenTitle={tokenTitle}
          onClose={() => setShowModal(false)}
        />
      )}
    </section>
  )
}
