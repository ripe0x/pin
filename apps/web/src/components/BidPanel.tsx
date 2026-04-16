"use client"

import { useState } from "react"
import { parseEther, formatEther } from "viem"
import {
  useAccount,
  useSimulateContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { useConnectModal } from "@rainbow-me/rainbowkit"
import { nftMarketAbi } from "@commonground/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@commonground/addresses"
import { CountdownTimer } from "./CountdownTimer"
import { StatusBadge } from "./StatusBadge"

type AuctionData = {
  auctionId: bigint
  seller: string
  reservePrice: bigint
  highestBid: bigint
  highestBidder: string
  endTime: number
  status: "live" | "settled" | "available"
}

type BuyNowData = {
  seller: string
  price: bigint
}

type TokenPageData = {
  contract: string
  tokenId: string
  auction?: AuctionData
  buyNow?: BuyNowData
  chainId?: number
}

export function BidPanel({ data }: { data: TokenPageData }) {
  const { auction, buyNow, contract, tokenId } = data
  const chainId = data.chainId ?? MAINNET_CHAIN_ID
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const [bidAmount, setBidAmount] = useState("")

  // Determine the current status
  const now = Math.floor(Date.now() / 1000)
  const auctionEnded = auction && auction.endTime > 0 && auction.endTime < now
  const needsSettlement = auctionEnded && auction.status !== "settled"

  // Simulate bid
  const { data: simulateBid } = useSimulateContract({
    address: NFT_MARKET[chainId as keyof typeof NFT_MARKET],
    abi: nftMarketAbi,
    functionName: "placeBidV2",
    args: auction ? [auction.auctionId] : undefined,
    value: bidAmount ? parseEther(bidAmount) : undefined,
    query: {
      enabled:
        isConnected &&
        !!auction &&
        !auctionEnded &&
        bidAmount !== "" &&
        parseFloat(bidAmount) > 0,
    },
  })

  const {
    writeContract: writeBid,
    data: bidTxHash,
    isPending: isBidPending,
  } = useWriteContract()

  const { isLoading: isBidConfirming } = useWaitForTransactionReceipt({
    hash: bidTxHash,
  })

  // Simulate finalize
  const { data: simulateFinalize } = useSimulateContract({
    address: NFT_MARKET[chainId as keyof typeof NFT_MARKET],
    abi: nftMarketAbi,
    functionName: "finalizeReserveAuction",
    args: auction ? [auction.auctionId] : undefined,
    query: { enabled: !!needsSettlement && isConnected },
  })

  const {
    writeContract: writeFinalize,
    data: finalizeTxHash,
    isPending: isFinalizePending,
  } = useWriteContract()

  const { isLoading: isFinalizeConfirming } = useWaitForTransactionReceipt({
    hash: finalizeTxHash,
  })

  const {
    writeContract: writeBuyNow,
    data: buyTxHash,
    isPending: isBuyPending,
  } = useWriteContract()

  const { isLoading: isBuyConfirming } = useWaitForTransactionReceipt({
    hash: buyTxHash,
  })

  function handleBid() {
    if (!simulateBid?.request) return
    writeBid(simulateBid.request)
  }

  function handleFinalize() {
    if (!simulateFinalize?.request) return
    writeFinalize(simulateFinalize.request)
  }

  function handleBuyNow() {
    if (!buyNow || !contract) return
    writeBuyNow({
      address: NFT_MARKET[chainId as keyof typeof NFT_MARKET],
      abi: nftMarketAbi,
      functionName: "buyV2",
      args: [contract as `0x${string}`, BigInt(tokenId), buyNow.price, "0x0000000000000000000000000000000000000000"],
      value: buyNow.price,
    })
  }

  return (
    <div className="space-y-6">
      {/* Auction panel */}
      {auction && (
        <>
          <StatusBadge
            status={
              needsSettlement ? "settled" : auctionEnded ? "sold" : "live"
            }
          />

          {/* Price display */}
          <div className="space-y-1">
            <p className="text-sm text-gray-400">
              {auction.highestBid > 0n ? "Current bid" : "Reserve price"}
            </p>
            <p className="font-mono text-4xl font-medium">
              {formatEther(
                auction.highestBid > 0n
                  ? auction.highestBid
                  : auction.reservePrice
              )}{" "}
              ETH
            </p>
          </div>

          {/* Countdown */}
          {!auctionEnded && auction.endTime > 0 && (
            <div className="space-y-1">
              <p className="text-sm text-gray-400">Ending in</p>
              <p className="text-2xl">
                <CountdownTimer endTime={auction.endTime} />
              </p>
            </div>
          )}

          {/* Settle CTA */}
          {needsSettlement && (
            <button
              onClick={handleFinalize}
              disabled={
                !isConnected ||
                !simulateFinalize?.request ||
                isFinalizePending ||
                isFinalizeConfirming
              }
              className="w-full rounded-lg bg-black py-3 text-base font-medium text-white transition-colors hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400"
            >
              {isFinalizePending || isFinalizeConfirming
                ? "Settling…"
                : "Settle Auction"}
            </button>
          )}

          {/* Bid input */}
          {!auctionEnded && (
            <div className="space-y-3">
              <div className="flex items-center rounded-lg border border-gray-200 focus-within:border-black transition-colors">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder={
                    auction.highestBid > 0n
                      ? `Min ${formatEther((auction.highestBid * 105n) / 100n)} ETH`
                      : `Min ${formatEther(auction.reservePrice)} ETH`
                  }
                  value={bidAmount}
                  onChange={(e) => setBidAmount(e.target.value)}
                  className="flex-1 bg-transparent px-4 py-3 font-mono text-base outline-none placeholder:text-gray-400"
                />
                <span className="pr-4 text-sm text-gray-400">ETH</span>
              </div>
              <button
                onClick={isConnected ? handleBid : openConnectModal}
                disabled={
                  isConnected &&
                  (!simulateBid?.request || isBidPending || isBidConfirming)
                }
                className="w-full rounded-lg bg-black py-3 text-base font-medium text-white transition-colors hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400"
              >
                {!isConnected
                  ? "Connect Wallet to Bid"
                  : isBidPending || isBidConfirming
                    ? "Placing Bid…"
                    : "Place Bid"}
              </button>
            </div>
          )}
        </>
      )}

      {/* Buy Now panel (no auction) */}
      {buyNow && !auction && (
        <>
          <StatusBadge status="available" />
          <div className="space-y-1">
            <p className="text-sm text-gray-400">Price</p>
            <p className="font-mono text-4xl font-medium">
              {formatEther(buyNow.price)} ETH
            </p>
          </div>
          <button
            onClick={isConnected ? handleBuyNow : openConnectModal}
            disabled={isBuyPending || isBuyConfirming}
            className="w-full rounded-lg bg-black py-3 text-base font-medium text-white transition-colors hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400"
          >
            {!isConnected
              ? "Connect Wallet to Buy"
              : isBuyPending || isBuyConfirming
                ? "Buying…"
                : "Buy Now"}
          </button>
        </>
      )}

      {/* No listing */}
      {!auction && !buyNow && (
        <div className="space-y-2">
          <StatusBadge status="sold" />
          <p className="text-sm text-gray-400">
            This work is not currently listed for sale.
          </p>
        </div>
      )}
    </div>
  )
}
