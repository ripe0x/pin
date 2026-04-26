"use client"

import { useEffect, useMemo, useState } from "react"
import { formatEther, parseEther } from "viem"
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { nftMarketAbi, pndAuctionHouseAbi } from "@pin/abi"
import type {
  AuctionFees,
  AuctionState,
  BidHistoryEntry,
} from "@/lib/auctions"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Display strings come back as either an ENS name or a 0x… truncation; this
 *  decides whether to render them with a mono font. */
function isAddress(display: string): boolean {
  return display.startsWith("0x")
}

function formatRelativeTime(unixSec: number): string {
  if (unixSec === 0) return ""
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSec)
  if (diffSec < 60) return `${diffSec}s ago`
  const m = Math.floor(diffSec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
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

function getPhase(auction: AuctionState, nowSec: number): Phase {
  if (auction.awaitingFirstBid) return "no-bids"
  if (Number(auction.endTime) <= nowSec) return "ended-unsettled"
  return "live"
}

export function AuctionPanel({
  auction,
}: {
  auction: AuctionState
}) {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  const phase = getPhase(auction, nowSec)

  const { amount, bidderDisplay, endTime, fees, bidHistory } = auction

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
            {phase !== "no-bids" && bidderDisplay && (
              <p className="text-xs text-gray-500 mt-2">
                by <span className={isAddress(bidderDisplay) ? "font-mono" : ""}>{bidderDisplay}</span>
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

        {auction.awaitingFirstBid && <SellerActions auction={auction} />}
      </div>

      {bidHistory.length > 0 && <BidHistory bids={bidHistory} />}
      {fees && <FeesBreakdown fees={fees} />}
    </div>
  )
}

function BidHistory({ bids }: { bids: BidHistoryEntry[] }) {
  return (
    <div className="px-5 py-4 border-t border-gray-100">
      <p className="text-[11px] uppercase tracking-[0.08em] text-gray-400 mb-3">
        Bid history
      </p>
      <ol className="space-y-2.5">
        {bids.map((bid) => (
          <li
            key={`${bid.txHash}-${bid.bidder}`}
            className="flex items-baseline justify-between text-xs"
          >
            <a
              href={`https://etherscan.io/tx/${bid.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-baseline gap-2 min-w-0 hover:opacity-70 transition-opacity"
            >
              <span
                className={`truncate ${isAddress(bid.bidderDisplay) ? "font-mono" : "font-medium"} text-gray-700`}
              >
                {bid.bidderDisplay}
              </span>
              <span className="text-gray-400 shrink-0">
                {formatRelativeTime(bid.blockTime)}
              </span>
            </a>
            <span className="font-medium tabular-nums text-gray-900 shrink-0 ml-3">
              {formatEther(bid.amount)} ETH
            </span>
          </li>
        ))}
      </ol>
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

function BidSection({ auction }: { auction: AuctionState }) {
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
    if (auction.source === "foundation") {
      writeContract({
        address: auction.marketAddress,
        abi: nftMarketAbi,
        functionName: "placeBidV2",
        args: [
          BigInt(auction.auctionId),
          validation.amount,
          ZERO_ADDRESS as `0x${string}`,
        ],
        value: validation.amount,
      })
    } else {
      writeContract({
        address: auction.marketAddress,
        abi: pndAuctionHouseAbi,
        functionName: "createBid",
        args: [BigInt(auction.auctionId)],
        value: validation.amount,
      })
    }
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

function SettleSection({ auction }: { auction: AuctionState }) {
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
    if (auction.source === "foundation") {
      writeContract({
        address: auction.marketAddress,
        abi: nftMarketAbi,
        functionName: "finalizeReserveAuction",
        args: [BigInt(auction.auctionId)],
      })
    } else {
      writeContract({
        address: auction.marketAddress,
        abi: pndAuctionHouseAbi,
        functionName: "endAuction",
        args: [BigInt(auction.auctionId)],
      })
    }
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

/**
 * Cancel + Edit-reserve actions for the auction seller. Only renders when the
 * connected wallet is the seller AND no bids have been placed yet — both
 * actions revert on-chain after the first bid.
 */
function SellerActions({ auction }: { auction: AuctionState }) {
  const { address } = useAccount()
  const isSeller =
    !!address && address.toLowerCase() === auction.seller.toLowerCase()
  const [editing, setEditing] = useState(false)
  const [reserveInput, setReserveInput] = useState("")

  const {
    writeContract: writeCancel,
    data: cancelHash,
    isPending: cancelPending,
    error: cancelError,
    reset: resetCancel,
  } = useWriteContract()
  const { isLoading: cancelMining, isSuccess: cancelSuccess } =
    useWaitForTransactionReceipt({ hash: cancelHash })

  const {
    writeContract: writeUpdate,
    data: updateHash,
    isPending: updatePending,
    error: updateError,
    reset: resetUpdate,
  } = useWriteContract()
  const { isLoading: updateMining, isSuccess: updateSuccess } =
    useWaitForTransactionReceipt({ hash: updateHash })

  if (!isSeller) return null

  if (cancelSuccess || updateSuccess) {
    return (
      <button
        onClick={() => {
          resetCancel()
          resetUpdate()
          window.location.reload()
        }}
        className="text-xs text-emerald-700 hover:underline"
      >
        Saved. Refresh to see updated state.
      </button>
    )
  }

  function handleCancel() {
    if (auction.source === "foundation") {
      writeCancel({
        address: auction.marketAddress,
        abi: nftMarketAbi,
        functionName: "cancelReserveAuction",
        args: [BigInt(auction.auctionId)],
      })
    } else {
      writeCancel({
        address: auction.marketAddress,
        abi: pndAuctionHouseAbi,
        functionName: "cancelAuction",
        args: [BigInt(auction.auctionId)],
      })
    }
  }

  function handleUpdate() {
    let parsed: bigint
    try {
      parsed = parseEther(reserveInput.trim() as `${number}`)
    } catch {
      return
    }
    if (parsed === 0n) return
    if (auction.source === "foundation") {
      writeUpdate({
        address: auction.marketAddress,
        abi: nftMarketAbi,
        functionName: "updateReserveAuction",
        args: [BigInt(auction.auctionId), parsed],
      })
    } else {
      writeUpdate({
        address: auction.marketAddress,
        abi: pndAuctionHouseAbi,
        functionName: "setAuctionReservePrice",
        args: [BigInt(auction.auctionId), parsed],
      })
    }
  }

  const busy = cancelPending || cancelMining || updatePending || updateMining

  return (
    <div className="pt-2 border-t border-gray-100 space-y-2">
      {editing ? (
        <div className="space-y-2">
          <div className="flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors rounded">
            <input
              type="text"
              inputMode="decimal"
              placeholder={formatEther(auction.amount > 0n ? auction.amount : auction.minBidWei)}
              value={reserveInput}
              onChange={(e) => setReserveInput(e.target.value)}
              disabled={busy}
              className="flex-1 px-3 py-2 text-sm font-medium outline-none disabled:opacity-40 bg-transparent"
            />
            <span className="flex items-center px-3 text-xs text-gray-400 border-l border-gray-200">
              ETH
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleUpdate}
              disabled={busy || !reserveInput.trim()}
              className="flex-1 text-xs font-medium py-2 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed rounded"
            >
              {updatePending
                ? "Confirm…"
                : updateMining
                  ? "Updating…"
                  : "Save reserve"}
            </button>
            <button
              onClick={() => {
                setEditing(false)
                setReserveInput("")
              }}
              disabled={busy}
              className="text-xs text-gray-500 px-3 hover:text-black transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setEditing(true)}
            disabled={busy}
            className="text-xs text-gray-500 hover:text-black transition-colors disabled:opacity-40"
          >
            Edit reserve
          </button>
          <button
            onClick={handleCancel}
            disabled={busy}
            className="text-xs text-gray-500 hover:text-red-600 transition-colors disabled:opacity-40"
          >
            {cancelPending
              ? "Confirm…"
              : cancelMining
                ? "Cancelling…"
                : "Cancel auction"}
          </button>
        </div>
      )}
      {(cancelError || updateError) && (
        <p className="text-xs text-red-500 break-words">
          {(cancelError || updateError)!.message.includes("User rejected")
            ? "Transaction rejected"
            : (cancelError || updateError)!.message.split("\n")[0]}
        </p>
      )}
    </div>
  )
}
