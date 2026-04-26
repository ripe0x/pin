"use client"

import { useEffect, useMemo, useState } from "react"
import { formatEther, parseEther } from "viem"
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import type { AuctionFees, FoundationAuctionState } from "@/lib/auctions"

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function formatRemaining(secondsLeft: number): string {
  if (secondsLeft <= 0) return "Ended"
  const d = Math.floor(secondsLeft / 86400)
  const h = Math.floor((secondsLeft % 86400) / 3600)
  const m = Math.floor((secondsLeft % 3600) / 60)
  const s = secondsLeft % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatBpsPct(bps: number): string {
  const pct = bps / 100
  if (Number.isInteger(pct)) return `${pct}%`
  return `${pct.toFixed(2).replace(/\.?0+$/, "")}%`
}

function Countdown({ endTime }: { endTime: bigint }) {
  const target = Number(endTime) * 1000
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const secondsLeft = Math.max(0, Math.floor((target - now) / 1000))
  return <span suppressHydrationWarning>{formatRemaining(secondsLeft)}</span>
}

type Phase = "live" | "no-bids" | "ended-unsettled"

function getPhase(auction: FoundationAuctionState, nowSec: number): Phase {
  if (auction.awaitingFirstBid) return "no-bids"
  if (Number(auction.endTime) <= nowSec) return "ended-unsettled"
  return "live"
}

export function FoundationAuctionPanel({
  auction,
}: {
  auction: FoundationAuctionState
}) {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  const phase = getPhase(auction, nowSec)

  const { amount, bidder, endTime, fees } = auction

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-5 pt-5 pb-4 space-y-5">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${phase === "ended-unsettled" ? "bg-amber-500" : "bg-emerald-500 animate-pulse"}`} />
          <span className="text-[11px] uppercase tracking-[0.08em] font-medium text-gray-500">
            {phase === "ended-unsettled" ? "Auction ended" : "Live auction"}
          </span>
        </div>

        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">
              {phase === "no-bids" ? "Reserve" : "Current bid"}
            </p>
            <p className="text-3xl font-semibold tracking-tight tabular-nums leading-none">
              {formatEther(amount)} <span className="text-base font-normal text-gray-500">ETH</span>
            </p>
            {phase !== "no-bids" && (
              <p className="text-xs text-gray-500 mt-2 font-mono">
                by {truncateAddress(bidder)}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">
              {phase === "no-bids" ? "Status" : phase === "ended-unsettled" ? "Ended" : "Ends in"}
            </p>
            <p className="text-lg font-semibold tracking-tight tabular-nums leading-none">
              {phase === "no-bids" ? (
                <span className="text-gray-500 font-normal text-base">No bids yet</span>
              ) : phase === "ended-unsettled" ? (
                <span className="text-amber-600">Awaiting settlement</span>
              ) : (
                <Countdown endTime={endTime} />
              )}
            </p>
          </div>
        </div>

        {phase === "ended-unsettled" ? (
          <SettleSection auction={auction} />
        ) : (
          <BidSection auction={auction} />
        )}
      </div>

      {fees && <FeesBreakdown fees={fees} />}
    </div>
  )
}

function FeesBreakdown({ fees }: { fees: AuctionFees }) {
  const rows: Array<[string, number]> = [
    [`${fees.platformLabel} fee`, fees.protocolFeeBps],
    ["Creator royalty", fees.creatorRoyaltyBps],
    ["Seller receives", fees.sellerBps],
  ].filter(([, bps]) => (bps as number) > 0) as Array<[string, number]>

  if (rows.length === 0) return null

  return (
    <div className="px-5 py-4 bg-gray-50 border-t border-gray-100">
      <p className="text-[11px] uppercase tracking-[0.08em] text-gray-400 mb-2">
        On settlement
      </p>
      <dl className="space-y-1">
        {rows.map(([label, bps]) => (
          <div key={label} className="flex items-baseline justify-between text-xs">
            <dt className="text-gray-500">{label}</dt>
            <dd className="font-medium tabular-nums text-gray-700">{formatBpsPct(bps)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function BidSection({ auction }: { auction: FoundationAuctionState }) {
  const { address } = useAccount()
  const minBidWei = auction.minBidWei
  const minBidEth = formatEther(minBidWei)
  const [input, setInput] = useState("")

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract()
  const { isLoading: isTxPending, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  const validation = useMemo(() => {
    if (!input.trim()) return { ok: false as const, reason: null }
    let parsed: bigint
    try {
      parsed = parseEther(input.trim() as `${number}`)
    } catch {
      return { ok: false as const, reason: "Invalid amount" }
    }
    if (parsed < minBidWei) {
      return { ok: false as const, reason: `Minimum bid is ${minBidEth} ETH` }
    }
    return { ok: true as const, amount: parsed }
  }, [input, minBidWei, minBidEth])

  const isPending = isWritePending || isTxPending
  const isSelfOutbidding =
    !!address && address.toLowerCase() === auction.bidder.toLowerCase()

  function handleBid() {
    if (!validation.ok) return
    writeContract({
      address: MARKET_ADDRESS,
      abi: nftMarketAbi,
      functionName: "placeBidV2",
      args: [
        BigInt(auction.auctionId),
        validation.amount,
        ZERO_ADDRESS as `0x${string}`,
      ],
      value: validation.amount,
    })
  }

  if (isSuccess) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-green-700">
          Bid placed. Refresh to see updated state.
        </p>
        <button
          onClick={() => {
            reset()
            window.location.reload()
          }}
          className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors"
        >
          Refresh
        </button>
      </div>
    )
  }

  if (!address) {
    return (
      <ConnectButton.Custom>
        {({ openConnectModal }) => (
          <button
            onClick={openConnectModal}
            className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors"
          >
            Connect wallet to bid
          </button>
        )}
      </ConnectButton.Custom>
    )
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="sr-only">Bid amount in ETH</span>
        <div className="flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors">
          <input
            type="text"
            inputMode="decimal"
            placeholder={minBidEth}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isPending}
            className="flex-1 px-3 py-3 text-base font-medium outline-none disabled:opacity-40"
          />
          <span className="flex items-center px-3 text-sm text-gray-400 border-l border-gray-200">
            ETH
          </span>
        </div>
      </label>
      <p className="text-xs text-gray-400">Minimum bid: {minBidEth} ETH</p>

      <button
        onClick={handleBid}
        disabled={isPending || !validation.ok || isSelfOutbidding}
        className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isWritePending
          ? "Confirm in wallet…"
          : isTxPending
            ? "Placing bid…"
            : isSelfOutbidding
              ? "You're already the highest bidder"
              : "Place bid"}
      </button>

      {validation.reason && input.trim() && (
        <p className="text-xs text-red-500">{validation.reason}</p>
      )}
      {writeError && (
        <p className="text-xs text-red-500 break-words">
          {writeError.message.includes("User rejected")
            ? "Transaction rejected"
            : writeError.message.includes("insufficient funds")
              ? "Insufficient ETH balance"
              : `Bid failed: ${writeError.message.split("\n")[0]}`}
        </p>
      )}
    </div>
  )
}

function SettleSection({ auction }: { auction: FoundationAuctionState }) {
  const { address } = useAccount()
  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract()
  const { isLoading: isTxPending, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  const isPending = isWritePending || isTxPending

  function handleSettle() {
    writeContract({
      address: MARKET_ADDRESS,
      abi: nftMarketAbi,
      functionName: "finalizeReserveAuction",
      args: [BigInt(auction.auctionId)],
    })
  }

  if (isSuccess) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-green-700">
          Auction settled. NFT transferred to the winner.
        </p>
        <button
          onClick={() => {
            reset()
            window.location.reload()
          }}
          className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors"
        >
          Refresh
        </button>
      </div>
    )
  }

  if (!address) {
    return (
      <ConnectButton.Custom>
        {({ openConnectModal }) => (
          <button
            onClick={openConnectModal}
            className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors"
          >
            Connect wallet to settle
          </button>
        )}
      </ConnectButton.Custom>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        Auction has ended. Anyone can settle it to transfer the NFT to the
        winning bidder and pay the seller.
      </p>
      <button
        onClick={handleSettle}
        disabled={isPending}
        className="block w-full text-center text-sm font-medium py-3 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isWritePending
          ? "Confirm in wallet…"
          : isTxPending
            ? "Settling…"
            : "Settle auction"}
      </button>
      {writeError && (
        <p className="text-xs text-red-500 break-words">
          {writeError.message.includes("User rejected")
            ? "Transaction rejected"
            : `Settle failed: ${writeError.message.split("\n")[0]}`}
        </p>
      )}
    </div>
  )
}
