"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { formatEther } from "viem"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import { createProvider, type PinStatus } from "@/lib/pinning"
import { TokenPinStatus } from "@/components/preserve/TokenPinStatus"

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]

type GalleryItem = {
  contract: string
  tokenId: string
  title: string
  imageUrl: string
  creator: string
  metadataCid: string | null
  mediaCid: string | null
}

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

function isVideoUrl(url: string): boolean {
  const path = url.split("?")[0].toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext))
}

export function ArtistGallery({
  items,
  artistAddress,
}: {
  items: GalleryItem[]
  artistAddress: string
}) {
  const { address: connectedAddress } = useAccount()
  const isOwner =
    !!connectedAddress &&
    connectedAddress.toLowerCase() === artistAddress.toLowerCase()

  const [pinStatuses, setPinStatuses] = useState<Map<string, PinStatus>>(
    new Map(),
  )
  const [hasProvider, setHasProvider] = useState(false)

  useEffect(() => {
    const providerType = localStorage.getItem("cg_pin_provider")
    const apiKey = localStorage.getItem("cg_pin_key")
    if (!providerType || !apiKey) return

    setHasProvider(true)
    const provider = createProvider(providerType as any, apiKey)

    // Collect unique CIDs to check
    const cids = new Set<string>()
    for (const item of items) {
      if (item.metadataCid) cids.add(item.metadataCid)
      if (item.mediaCid) cids.add(item.mediaCid)
    }

    // Check pin status for each CID
    async function checkAll() {
      const statuses = new Map<string, PinStatus>()
      await Promise.all(
        Array.from(cids).map(async (cid) => {
          try {
            const status = await provider.checkPin(cid)
            statuses.set(cid, status)
          } catch {
            statuses.set(cid, "unknown")
          }
        }),
      )
      setPinStatuses(statuses)
    }

    checkAll()
  }, [items])

  if (items.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-lg">No works found</p>
        <p className="text-sm mt-1">
          This artist hasn&apos;t minted any works on Foundation yet.
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {items.map((item) => (
        <GalleryCard
          key={`${item.contract}:${item.tokenId}`}
          item={item}
          pinStatuses={pinStatuses}
          hasProvider={hasProvider}
          isOwner={isOwner}
        />
      ))}
    </div>
  )
}

function getItemPinStatus(
  item: GalleryItem,
  pinStatuses: Map<string, PinStatus>,
): PinStatus | null {
  // Consider an item pinned if its media CID is pinned (primary)
  // or its metadata CID is pinned (fallback)
  const mediaSt = item.mediaCid ? pinStatuses.get(item.mediaCid) : undefined
  const metaSt = item.metadataCid
    ? pinStatuses.get(item.metadataCid)
    : undefined

  if (mediaSt === "pinned" || mediaSt === "queued") return "pinned"
  if (metaSt === "pinned" || metaSt === "queued") return "pinned"

  // If we checked and neither is pinned
  if (mediaSt || metaSt) return "unknown"

  return null // not checked yet
}

function GalleryCard({
  item,
  pinStatuses,
  hasProvider,
  isOwner,
}: {
  item: GalleryItem
  pinStatuses: Map<string, PinStatus>
  hasProvider: boolean
  isOwner: boolean
}) {
  const href = `/${item.contract}/${item.tokenId}`
  const isVideo = isVideoUrl(item.imageUrl)
  const pinStatus = hasProvider ? getItemPinStatus(item, pinStatuses) : null

  return (
    <div className="group border border-gray-200 transition-colors hover:border-gray-400">
      <Link href={href}>
        <div className="relative overflow-hidden bg-gray-100 aspect-[4/5]">
          {isVideo ? (
            <video
              src={item.imageUrl}
              className="w-full h-full object-cover"
              muted
              playsInline
              preload="metadata"
            />
          ) : (
            <img
              src={item.imageUrl}
              alt={item.title}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          )}
        </div>
        <div className="p-4 flex items-center justify-between gap-2">
          <p className="text-base font-medium leading-tight truncate">
            {item.title}
          </p>
          {pinStatus && <TokenPinStatus status={pinStatus} />}
        </div>
      </Link>
      {isOwner && (
        <BuyPriceSection
          nftContract={item.contract}
          tokenId={item.tokenId}
        />
      )}
    </div>
  )
}

function BuyPriceSection({
  nftContract,
  tokenId,
}: {
  nftContract: string
  tokenId: string
}) {
  const { data: buyPrice } = useReadContract({
    address: MARKET_ADDRESS,
    abi: nftMarketAbi,
    functionName: "getBuyPrice",
    args: [nftContract as `0x${string}`, BigInt(tokenId)],
  })

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
  } = useWriteContract()

  const { isLoading: isTxPending, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  if (!buyPrice) return null

  const { seller, price } = buyPrice as unknown as { seller: string; price: bigint }
  const hasListing =
    seller !== "0x0000000000000000000000000000000000000000" && price > 0n

  if (!hasListing || isSuccess) return null

  function handleCancel() {
    writeContract({
      address: MARKET_ADDRESS,
      abi: nftMarketAbi,
      functionName: "cancelBuyPrice",
      args: [nftContract as `0x${string}`, BigInt(tokenId)],
    })
  }

  const isPending = isWritePending || isTxPending

  return (
    <div className="px-4 pb-4 space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-500">Listed for</span>
        <span className="font-medium">{formatEther(price)} ETH</span>
      </div>
      <button
        onClick={handleCancel}
        disabled={isPending}
        className="w-full text-xs font-medium py-2 border border-gray-200 rounded hover:border-gray-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isWritePending
          ? "Confirm in wallet..."
          : isTxPending
            ? "Canceling..."
            : "Cancel Listing"}
      </button>
      {writeError && (
        <p className="text-xs text-red-500 truncate">
          {writeError.message.includes("User rejected")
            ? "Transaction rejected"
            : "Failed to cancel"}
        </p>
      )}
    </div>
  )
}
