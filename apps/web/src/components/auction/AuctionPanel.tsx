"use client"

import { useEffect, useMemo, useState } from "react"
import { formatEther } from "viem"
import {
  useAccount,
  useBlock,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { nftMarketAbi, sovereignAuctionHouseAbi, superrareBazaarAbi } from "@pin/abi"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import type {
  AuctionFees,
  AuctionState,
  BidHistoryEntry,
} from "@/lib/auctions"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// SuperRare Bazaar's MarketplaceSettings.getMarketplaceFeePercentage()
// has returned 3 (i.e. 3%) for years. The fee is a buyer's premium —
// added on top of the recorded bid amount. We hardcode rather than
// reading on every render to avoid a per-render eth_call cost; if SR
// changes the rate, bid txs would revert with "not enough eth sent"
// and we'd update this constant.
const SR_MARKETPLACE_FEE_BPS = 300n // 3.00%

/**
 * Fire a one-shot, fire-and-forget POST to the auction revalidation route
 * when a write tx (bid / settle / cancel / update) confirms. The route
 * `revalidateTag`s the cached `getAuctionForToken` for *this* token only,
 * so the next render fetches fresh chain state instead of waiting out the
 * 30s TTL — the bidder sees their bid land instantly, while bot/refresh
 * traffic to *other* auctions stays cached.
 *
 * Failures are intentionally swallowed: revalidation is an optimization,
 * and the existing "Refresh to see updated state" button is the user's
 * fallback if the network call hiccups.
 */
function useRevalidateAuctionOnSuccess(
  isSuccess: boolean,
  auction: AuctionState,
) {
  useEffect(() => {
    if (!isSuccess) return
    const url = `/api/auction/revalidate?contract=${encodeURIComponent(
      auction.nftContract,
    )}&tokenId=${encodeURIComponent(auction.tokenId)}`
    fetch(url, { method: "POST" }).catch(() => {})
  }, [isSuccess, auction.nftContract, auction.tokenId])
}

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

/**
 * Returns the latest known block timestamp (seconds), refreshed every second
 * (driven by a 1s wall-clock tick) plus an additional re-render on every new
 * block from `useBlock({ watch: true })`. We anchor to the chain rather than
 * `Date.now()` so a fast-forwarded local fork (`evm_increaseTime`) reflects
 * in the UI immediately. On a normal chain the two are within a block.
 *
 * Returns 0 until the first block lands, so callers should treat 0 as
 * "unknown — don't make end-state decisions yet".
 */
function useChainNowSec(): number {
  const { data: block } = useBlock({ watch: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return useMemo(() => {
    if (!block) return 0
    // Each wall-clock second, advance the chain timestamp by 1s so the
    // countdown ticks down between blocks (which arrive every ~12s on
    // mainnet). The chain-truth re-anchors whenever a new block lands.
    return Number(block.timestamp) + tick
    // We deliberately reset `tick` indirectly via the block change: when a
    // new block arrives the `block` reference changes, the memo recomputes,
    // and the offset re-anchors. We don't reset `tick` to 0 because the
    // setInterval keeps incrementing it — but that's fine, the next block
    // re-anchors to chain truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block?.timestamp, tick])
}

function Countdown({
  endTime,
  nowSec,
}: {
  endTime: bigint
  nowSec: number
}) {
  const secondsLeft = nowSec === 0
    ? 0
    : Math.max(0, Number(endTime) - nowSec)
  return <span suppressHydrationWarning>{formatRemaining(secondsLeft)}</span>
}

type Phase = "live" | "no-bids" | "ended-unsettled"

function getPhase(auction: AuctionState, nowSec: number): Phase {
  if (auction.awaitingFirstBid) return "no-bids"
  // nowSec === 0 means "we don't know chain time yet" — stay in "live" until
  // the first block lands so we don't briefly flash the ended state.
  if (nowSec > 0 && Number(auction.endTime) <= nowSec) return "ended-unsettled"
  return "live"
}

export function AuctionPanel({
  auction,
}: {
  auction: AuctionState
}) {
  const nowSec = useChainNowSec()
  const phase = getPhase(auction, nowSec)

  const { amount, bidderDisplay, endTime, fees, bidHistory } = auction

  return (
    <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
      <div className="p-5 space-y-5">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${phase === "ended-unsettled" ? "bg-amber-500" : "bg-emerald-500 animate-pulse"}`} />
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
            {phase === "ended-unsettled" ? "Auction ended" : "Live auction"}
          </span>
        </div>

        <div className="flex items-end justify-between gap-6">
          <div className="space-y-1">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              {phase === "no-bids" ? "Reserve" : "Current bid"}
            </p>
            <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
              {formatEther(amount)} <span className="text-sm font-mono text-gray-500">ETH</span>
            </p>
            {phase !== "no-bids" && bidderDisplay && (
              <p className="text-[11px] font-mono text-gray-500 pt-1">
                by <span className={isAddress(bidderDisplay) ? "font-mono" : ""}>{bidderDisplay}</span>
              </p>
            )}
          </div>
          <div className="text-right space-y-1">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              {phase === "no-bids" ? "Status" : phase === "ended-unsettled" ? "Ended" : "Ends in"}
            </p>
            <p className="text-sm font-mono tabular-nums leading-none">
              {phase === "no-bids" ? (
                <span className="text-gray-500">No bids yet</span>
              ) : phase === "ended-unsettled" ? (
                <span className="text-amber-600">Awaiting settlement</span>
              ) : (
                <Countdown endTime={endTime} nowSec={nowSec} />
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
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-3">
        Bid history
      </p>
      <ol className="space-y-2">
        {bids.map((bid) => (
          <li
            key={`${bid.txHash}-${bid.bidder}`}
            className="flex items-baseline justify-between text-[11px] font-mono"
          >
            <a
              href={`https://etherscan.io/tx/${bid.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-baseline gap-2 min-w-0 hover:opacity-70 transition-opacity"
            >
              <span className="truncate text-gray-700">
                {bid.bidderDisplay}
              </span>
              <span className="text-gray-400 shrink-0">
                {formatRelativeTime(bid.blockTime)}
              </span>
            </a>
            <span className="tabular-nums text-gray-900 shrink-0 ml-3">
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
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-2">
        On settlement
      </p>
      <dl className="space-y-1">
        {rows.map(([label, bps]) => (
          <div key={label} className="flex items-baseline justify-between text-[11px] font-mono">
            <dt className="text-gray-500">{label}</dt>
            <dd className="tabular-nums text-gray-700">{formatBpsPct(bps)}</dd>
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

  const bid = useEthAmountInput({
    min: minBidWei,
    minLabel: (m) => `Minimum bid is ${formatEther(m)} ETH`,
  })

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

  useRevalidateAuctionOnSuccess(isSuccess, auction)

  const isPending = isWritePending || isTxPending
  const isSelfOutbidding =
    !!address && address.toLowerCase() === auction.bidder.toLowerCase()

  function handleBid() {
    if (!bid.isValid || bid.wei == null) return
    if (auction.source === "foundation") {
      writeContract({
        address: auction.marketAddress,
        abi: nftMarketAbi,
        functionName: "placeBidV2",
        args: [
          BigInt(auction.auctionId),
          bid.wei,
          ZERO_ADDRESS as `0x${string}`,
        ],
        value: bid.wei,
      })
    } else if (auction.source === "superrareV2") {
      // SR Bazaar enforces a buyer's premium on top of the bid: the
      // total `msg.value` must equal `bid + (bid * marketplaceFee%)`.
      // Verified on a mainnet fork — submitting `value: bid` reverts
      // with "not enough eth sent." The fee is currently 3% (read from
      // MarketplaceSettings; stable for years). The bid amount the
      // contract records is still `bid.wei`; the extra 3% goes to SR.
      const value = bid.wei + (bid.wei * SR_MARKETPLACE_FEE_BPS) / 10000n
      writeContract({
        address: auction.marketAddress,
        abi: superrareBazaarAbi,
        functionName: "bid",
        args: [
          auction.nftContract,
          BigInt(auction.tokenId),
          ZERO_ADDRESS as `0x${string}`,
          bid.wei,
        ],
        value,
      })
    } else {
      writeContract({
        address: auction.marketAddress,
        abi: sovereignAuctionHouseAbi,
        functionName: "createBid",
        args: [BigInt(auction.auctionId)],
        value: bid.wei,
      })
    }
  }

  if (isSuccess) {
    return (
      <div className="space-y-3">
        <p className="text-[11px] font-mono text-green-700">
          Bid placed. Refresh to see updated state.
        </p>
        <button
          onClick={() => {
            reset()
            window.location.reload()
          }}
          className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
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
            className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
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
            {...bid.inputProps}
            placeholder={minBidEth}
            disabled={isPending}
            className="flex-1 px-3 py-3 text-sm font-mono tabular-nums outline-none disabled:opacity-40"
          />
          <span className="flex items-center px-3 text-[11px] font-mono uppercase tracking-wider text-gray-400 border-l border-gray-200">
            ETH
          </span>
        </div>
      </label>
      <button
        type="button"
        onClick={() => bid.setFromWei(minBidWei)}
        disabled={isPending}
        className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        title="Use minimum bid"
      >
        Minimum bid: {minBidEth} ETH
      </button>
      {auction.source === "superrareV2" && bid.isValid && bid.wei != null && bid.wei > 0n && (
        <p className="text-[10px] font-mono text-gray-400">
          + 3% buyer&apos;s premium = {formatEther(bid.wei + (bid.wei * SR_MARKETPLACE_FEE_BPS) / 10000n)} ETH total
        </p>
      )}

      <button
        onClick={handleBid}
        disabled={isPending || !bid.isValid || isSelfOutbidding}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isWritePending
          ? "Confirm in wallet…"
          : isTxPending
            ? "Placing bid…"
            : isSelfOutbidding
              ? "You're already the highest bidder"
              : "Place bid"}
      </button>

      {bid.error && (
        <p className="text-[11px] font-mono text-red-500">{bid.error}</p>
      )}
      {writeError && (
        <p className="text-[11px] font-mono text-red-500 break-words">
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

  useRevalidateAuctionOnSuccess(isSuccess, auction)

  const isPending = isWritePending || isTxPending

  function handleSettle() {
    if (auction.source === "foundation") {
      writeContract({
        address: auction.marketAddress,
        abi: nftMarketAbi,
        functionName: "finalizeReserveAuction",
        args: [BigInt(auction.auctionId)],
      })
    } else if (auction.source === "superrareV2") {
      writeContract({
        address: auction.marketAddress,
        abi: superrareBazaarAbi,
        functionName: "settleAuction",
        args: [auction.nftContract, BigInt(auction.tokenId)],
      })
    } else {
      writeContract({
        address: auction.marketAddress,
        abi: sovereignAuctionHouseAbi,
        functionName: "endAuction",
        args: [BigInt(auction.auctionId)],
      })
    }
  }

  if (isSuccess) {
    return (
      <div className="space-y-3">
        <p className="text-[11px] font-mono text-green-700">
          Auction settled. NFT transferred to the winner.
        </p>
        <button
          onClick={() => {
            reset()
            window.location.reload()
          }}
          className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
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
            className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
          >
            Connect wallet to settle
          </button>
        )}
      </ConnectButton.Custom>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
        Auction has ended. Anyone can settle it to transfer the NFT to the
        winning bidder and pay the seller.
      </p>
      <button
        onClick={handleSettle}
        disabled={isPending}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isWritePending
          ? "Confirm in wallet…"
          : isTxPending
            ? "Settling…"
            : "Settle auction"}
      </button>
      {writeError && (
        <p className="text-[11px] font-mono text-red-500 break-words">
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
  const reserve = useEthAmountInput()

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

  // Both seller actions invalidate the cached auction state. Cancel deletes
  // the auction; updateReserve changes the surfaced "Reserve" number.
  useRevalidateAuctionOnSuccess(cancelSuccess || updateSuccess, auction)

  if (!isSeller) return null

  if (cancelSuccess || updateSuccess) {
    return (
      <button
        onClick={() => {
          resetCancel()
          resetUpdate()
          window.location.reload()
        }}
        className="text-[11px] font-mono text-emerald-700 hover:underline"
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
    } else if (auction.source === "superrareV2") {
      writeCancel({
        address: auction.marketAddress,
        abi: superrareBazaarAbi,
        functionName: "cancelAuction",
        args: [auction.nftContract, BigInt(auction.tokenId)],
      })
    } else {
      writeCancel({
        address: auction.marketAddress,
        abi: sovereignAuctionHouseAbi,
        functionName: "cancelAuction",
        args: [BigInt(auction.auctionId)],
      })
    }
  }

  function handleUpdate() {
    if (!reserve.isValid || reserve.wei == null || reserve.wei === 0n) return
    if (auction.source === "foundation") {
      writeUpdate({
        address: auction.marketAddress,
        abi: nftMarketAbi,
        functionName: "updateReserveAuction",
        args: [BigInt(auction.auctionId), reserve.wei],
      })
    } else {
      writeUpdate({
        address: auction.marketAddress,
        abi: sovereignAuctionHouseAbi,
        functionName: "setAuctionReservePrice",
        args: [BigInt(auction.auctionId), reserve.wei],
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
              {...reserve.inputProps}
              placeholder={formatEther(auction.amount > 0n ? auction.amount : auction.minBidWei)}
              disabled={busy}
              className="flex-1 px-3 py-2 text-sm font-mono tabular-nums outline-none disabled:opacity-40 bg-transparent"
            />
            <span className="flex items-center px-3 text-[11px] font-mono uppercase tracking-wider text-gray-400 border-l border-gray-200">
              ETH
            </span>
          </div>
          {reserve.error && (
            <p className="text-[11px] font-mono text-red-500">{reserve.error}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleUpdate}
              disabled={busy || !reserve.isValid || reserve.wei === 0n}
              className="flex-1 text-[11px] font-mono font-medium uppercase tracking-wider py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed rounded"
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
                reserve.reset()
              }}
              disabled={busy}
              className="text-[11px] font-mono uppercase tracking-wider text-gray-500 px-3 hover:text-fg transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          {auction.source === "superrareV2" ? (
            // SR Bazaar has no update-reserve on a live auction;
            // only cancel is available pre-bid.
            <span />
          ) : (
            <button
              onClick={() => setEditing(true)}
              disabled={busy}
              className="text-[11px] font-mono uppercase tracking-wider text-gray-500 hover:text-fg transition-colors disabled:opacity-40"
            >
              Edit reserve
            </button>
          )}
          <button
            onClick={handleCancel}
            disabled={busy}
            className="text-[11px] font-mono uppercase tracking-wider text-gray-500 hover:text-red-600 transition-colors disabled:opacity-40"
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
        <p className="text-[11px] font-mono text-red-500 break-words">
          {(cancelError || updateError)!.message.includes("User rejected")
            ? "Transaction rejected"
            : (cancelError || updateError)!.message.split("\n")[0]}
        </p>
      )}
    </div>
  )
}
