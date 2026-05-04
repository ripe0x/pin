"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { formatEther } from "viem"
import {
  useAccount,
  useBalance,
  useBlock,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { foundry, mainnet } from "wagmi/chains"

// When the dev server is pointed at a local Anvil fork
// (NEXT_PUBLIC_USE_LOCAL_RPC=1), we're in fork-testing mode and the
// *preferred* chain is foundry — sending txs on real Ethereum
// mainnet would bypass the fork. In production this flag is unset
// and the preferred chain is mainnet. `NEXT_PUBLIC_*` vars are
// inlined at build time so this evaluates statically per build —
// which is exactly why the flag is a boolean string and not the
// Alchemy URL: anything in `NEXT_PUBLIC_*` ends up in the public
// JS bundle, so URLs containing API keys must stay out.
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const PREFERRED_CHAIN = FORK_MODE ? foundry : mainnet
const PREFERRED_CHAIN_LABEL = FORK_MODE ? "Foundry (local fork)" : "Ethereum"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { nftMarketAbi, sovereignAuctionHouseAbi, superrareBazaarAbi, transientAuctionHouseAbi } from "@pin/abi"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import type {
  AuctionFees,
  AuctionState,
  BidHistoryEntry,
} from "@/lib/auctions"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * Format a wagmi/viem write error for display. viem attaches the actual
 * revert reason on the error's `cause.cause...` chain (and a friendlier
 * `shortMessage` on the top-level error). The default Error.message is
 * a multi-line block whose first line is just "The contract function X
 * reverted with the following reason:" — useless without the next line.
 * Walk the cause chain to find the deepest message that contains the
 * actual on-chain revert string (typically prefixed `<func>::<reason>`).
 */
function formatWriteError(err: unknown, action: "Bid" | "Settle" | "Cancel" | "Update"): string {
  if (!err || typeof err !== "object") return `${action} failed`
  const e = err as {
    message?: string
    shortMessage?: string
    cause?: unknown
    metaMessages?: string[]
  }
  if (e.message?.includes("User rejected")) return "Transaction rejected"
  if (e.message?.includes("insufficient funds")) return "Insufficient ETH balance"

  // Walk cause chain for the deepest shortMessage / reason.
  let deepest: string | undefined = e.shortMessage
  let cur: unknown = e.cause
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const c = cur as { shortMessage?: string; reason?: string; cause?: unknown }
    if (c.shortMessage) deepest = c.shortMessage
    if (c.reason) deepest = c.reason
    cur = c.cause
  }
  // metaMessages often holds the reverted reason as a follow-on line.
  if (!deepest && Array.isArray(e.metaMessages)) {
    const reasonLine = e.metaMessages.find((m) =>
      /::|reverted|require/i.test(m),
    )
    if (reasonLine) deepest = reasonLine.trim()
  }
  if (!deepest) deepest = e.message?.split("\n")[0]
  return `${action} failed: ${deepest ?? "unknown error"}`
}

// SuperRare Bazaar's MarketplaceSettings.getMarketplaceFeePercentage()
// has returned 3 (i.e. 3%) for years. The fee is a buyer's premium —
// added on top of the recorded bid amount. We hardcode rather than
// reading on every render to avoid a per-render eth_call cost; if SR
// changes the rate, bid txs would revert with "not enough eth sent"
// and we'd update this constant.
const SR_MARKETPLACE_FEE_BPS = 300n // 3.00%

// Chainlink ETH/USD price feed on mainnet. Returns answer with 8 decimals.
// We read once per panel render via wagmi (cached by react-query); the
// number drives the "$X.XX" suffix on each fee row.
const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"
const chainlinkLatestAnswerAbi = [
  {
    type: "function",
    name: "latestAnswer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int256" }],
  },
] as const

/**
 * Current ETH/USD price from Chainlink. Returns null while loading or
 * if the read fails — callers should hide the USD column rather than
 * render a misleading "$0.00".
 */
function useEthPriceUsd(): number | null {
  const chainId = useChainId()
  const { data } = useReadContract({
    address: CHAINLINK_ETH_USD,
    abi: chainlinkLatestAnswerAbi,
    functionName: "latestAnswer",
    chainId,
  })
  if (data === undefined || data === null) return null
  // 8 decimals on the feed.
  return Number(data) / 1e8
}

/**
 * Compact ETH formatter: chooses precision by magnitude (avoid pretending
 * we know femtosats for 1.5 ETH) and strips trailing zeros so values
 * read as "0.3 ETH" / "1.7 ETH" / "0.06 ETH" instead of padded decimals.
 */
function formatEthShort(wei: bigint): string {
  const eth = Number(formatEther(wei))
  const fixed = eth >= 1 ? eth.toFixed(3) : eth >= 0.01 ? eth.toFixed(4) : eth.toFixed(5)
  // Strip trailing zeros after the decimal, then a hanging dot if any.
  return fixed.replace(/\.?0+$/, "")
}

const usdNoCents = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})
const usdWithCents = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function formatUsd(wei: bigint, ethPriceUsd: number): string {
  const usd = Number(formatEther(wei)) * ethPriceUsd
  // Cents only matter for sub-$100 amounts; above that the locale-aware
  // thousands separator (",") is what you want and decimals are noise.
  return usd >= 100 ? usdNoCents.format(usd) : usdWithCents.format(usd)
}

/**
 * On successful write tx: invalidate the cached `getAuctionForToken`
 * server-side (so the next read fetches fresh chain state instead of
 * waiting out the 30s TTL), then call `router.refresh()` to re-fetch
 * the server-rendered auction state in place — the panel re-renders
 * with the new bid / settled / cancelled state automatically. No manual
 * page reload needed.
 *
 * Network failures on the revalidate POST are swallowed: the
 * `router.refresh()` will still fire and the next read will hit a
 * still-warm cache (worst case: 30s of stale state until natural TTL).
 */
/**
 * Persistent confirmation banner shown after a write tx confirms.
 * Stays visible until the user dismisses (clicking Dismiss calls
 * `reset()` to clear wagmi's success state, which lets the panel
 * transition back to the regular form). Includes a link to Etherscan
 * for production txs; on fork-test runs the hash will 404 there but
 * that's the cost of one shared link target — fine for testing.
 */
function TxSuccessBanner({
  txHash,
  message,
  onDismiss,
}: {
  txHash: `0x${string}`
  message: string
  onDismiss: () => void
}) {
  return (
    <div className="px-3 py-2 bg-green-50 border border-green-200 text-green-800 text-[11px] font-mono space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span>{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-green-700 hover:text-green-900 leading-none"
        >
          ✕
        </button>
      </div>
      <a
        href={`https://etherscan.io/tx/${txHash}`}
        target="_blank"
        rel="noopener noreferrer"
        className="block underline hover:text-green-900 break-all"
      >
        View tx: {txHash.slice(0, 10)}…{txHash.slice(-8)} ↗
      </a>
    </div>
  )
}

function useRevalidateAuctionOnSuccess(
  isSuccess: boolean,
  auction: AuctionState,
  options?: {
    /**
     * Whether to call `router.refresh()` immediately after the cache
     * flush. Default true (the bid path wants the panel to re-render
     * with the new high-bid state in place). Pass `false` for settle /
     * cancel write paths where a refresh would unmount the panel —
     * including the success banner — before the user can read it.
     * In that case the caller is responsible for calling `router.refresh()`
     * (or a window reload) when the user dismisses the banner.
     */
    autoRefresh?: boolean
  },
) {
  const router = useRouter()
  const autoRefresh = options?.autoRefresh ?? true
  useEffect(() => {
    if (!isSuccess) return
    const url = `/api/auction/revalidate?contract=${encodeURIComponent(
      auction.nftContract,
    )}&tokenId=${encodeURIComponent(auction.tokenId)}`
    fetch(url, { method: "POST" })
      .catch(() => {})
      .finally(() => {
        if (autoRefresh) router.refresh()
      })
  }, [isSuccess, auction.nftContract, auction.tokenId, router, autoRefresh])
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
  const rawPhase = getPhase(auction, nowSec)

  const { amount, bidderDisplay, endTime, fees, bidHistory } = auction

  // Bid input state is owned at the panel level so both `BidSection`
  // (input + submit handler) and `FeesBreakdown` (live buyer's-premium
  // total) can read the same wei value. The hook is a no-op when the
  // user hasn't typed anything; SettleSection / SellerActions ignore it.
  const bid = useEthAmountInput({
    min: auction.minBidWei,
    minLabel: (m) => `Minimum bid is ${formatEther(m)} ETH`,
  })

  // Local override: when SettleSection / SellerActions report a
  // confirmed write tx, we keep the panel mounted (so the success
  // banner persists until the user dismisses), but we also need the
  // surrounding chrome — the status pill, "Ends in" line — to reflect
  // the new reality instead of stale "Awaiting settlement" / countdown.
  // SettleSection + cancel set this to "settled" / "cancelled" via the
  // setter passed below.
  const [postWriteState, setPostWriteState] = useState<
    null | "settled" | "cancelled"
  >(null)
  const phase = postWriteState ? "settled" : rawPhase

  const dotColor =
    phase === "settled"
      ? "bg-emerald-500"
      : phase === "ended-unsettled"
      ? "bg-amber-500"
      : "bg-emerald-500 animate-pulse"
  const headerLabel =
    phase === "settled"
      ? postWriteState === "cancelled"
        ? "Auction cancelled"
        : "Auction settled"
      : phase === "ended-unsettled"
      ? "Auction ended"
      : "Live auction"

  return (
    <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
      <div className="p-5 space-y-5">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
            {headerLabel}
          </span>
        </div>

        <div className="flex items-end justify-between gap-6">
          <div className="space-y-1">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              {phase === "no-bids"
                ? "Reserve"
                : phase === "settled"
                ? postWriteState === "cancelled"
                  ? "Reserve"
                  : "Final bid"
                : "Current bid"}
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
              {phase === "no-bids"
                ? "Status"
                : phase === "ended-unsettled" || phase === "settled"
                ? "Status"
                : "Ends in"}
            </p>
            <p className="text-sm font-mono tabular-nums leading-none">
              {phase === "no-bids" ? (
                <span className="text-gray-500">No bids yet</span>
              ) : phase === "settled" ? (
                <span className="text-emerald-600">
                  {postWriteState === "cancelled" ? "Cancelled" : "Settled"}
                </span>
              ) : phase === "ended-unsettled" ? (
                <span className="text-amber-600">Awaiting settlement</span>
              ) : (
                <Countdown endTime={endTime} nowSec={nowSec} />
              )}
            </p>
          </div>
        </div>

        {phase === "ended-unsettled" ? (
          <SettleSection
            auction={auction}
            onSettled={() => setPostWriteState("settled")}
          />
        ) : phase === "settled" ? null : (
          <BidSection auction={auction} bid={bid} />
        )}

        {auction.awaitingFirstBid && phase !== "settled" && (
          <SellerActions
            auction={auction}
            onCancelled={() => setPostWriteState("cancelled")}
          />
        )}
      </div>

      {bidHistory.length > 0 && <BidHistory bids={bidHistory} />}
      {fees && (
        <FeesBreakdown
          fees={fees}
          auction={auction}
          bidWei={bid.wei ?? undefined}
        />
      )}
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
              <span className="truncate text-fg-muted">
                {bid.bidderDisplay}
              </span>
              <span className="text-fg-subtle shrink-0">
                {formatRelativeTime(bid.blockTime)}
              </span>
            </a>
            <span className="tabular-nums text-fg shrink-0 ml-3">
              {formatEther(bid.amount)} ETH
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function FeesBreakdown({
  fees,
  auction,
  bidWei,
}: {
  fees: AuctionFees
  // Auction context lets us show the buyer's premium footer for
  // platforms that have one (currently only SR V2). Optional so other
  // call sites that don't care about live bid state can omit it.
  auction?: AuctionState
  // Live bid amount typed by the user, used to compute the dynamic
  // premium total. When 0n / undefined we fall back to the current
  // amount on the auction so the row still shows a meaningful preview.
  bidWei?: bigint
}) {
  const ethPriceUsd = useEthPriceUsd()

  const isFoundation = auction?.source === "foundation"
  const rows: Array<[string, number]> = (
    [
      [isFoundation ? "Artist receives" : "Creator royalty", fees.creatorRoyaltyBps],
      ["Seller receives", fees.sellerBps],
      [`${fees.platformLabel} fee`, fees.protocolFeeBps],
    ] as Array<[string, number]>
  ).filter(([label, bps]) => {
    // Always show the Foundation platform fee row, even at 0%, so the
    // breakdown makes the platform's take explicit on Foundation auctions.
    if (isFoundation && label === `${fees.platformLabel} fee`) return true
    return bps > 0
  })

  // Base amount each percentage row is computed against. Use the user's
  // typed bid when available; fall back to the current bid / reserve
  // so the row still shows a meaningful preview before they type.
  const previewBid = bidWei && bidWei > 0n ? bidWei : auction?.amount ?? 0n
  const showSrPremium = auction?.source === "superrareV2"
  const premiumWei =
    previewBid > 0n ? (previewBid * SR_MARKETPLACE_FEE_BPS) / 10000n : 0n

  if (rows.length === 0 && !showSrPremium) return null

  function rowAmounts(bps: number): { eth: string; usd: string | null } {
    if (previewBid === 0n) return { eth: "—", usd: null }
    const wei = (previewBid * BigInt(bps)) / 10000n
    return {
      eth: `${formatEthShort(wei)} ETH`,
      usd: ethPriceUsd ? formatUsd(wei, ethPriceUsd) : null,
    }
  }

  return (
    <div className="px-5 py-4 bg-surface-muted border-t border-gray-100">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-2">
        On settlement
      </p>
      <dl className="space-y-1">
        {rows.map(([label, bps]) => {
          const amt = rowAmounts(bps)
          return (
            <div
              key={label}
              className="flex items-baseline justify-between gap-3 text-[11px] font-mono"
            >
              <dt className="text-fg-muted">{label}</dt>
              <dd className="tabular-nums text-fg">
                <span>{formatBpsPct(bps)}</span>
                {previewBid > 0n && bps > 0 && (
                  <>
                    <span className="text-gray-400"> · </span>
                    <span>{amt.eth}</span>
                    {amt.usd && (
                      <span className="text-gray-400"> ({amt.usd})</span>
                    )}
                  </>
                )}
              </dd>
            </div>
          )
        })}
      </dl>
      {showSrPremium && (
        <>
          <hr className="my-3 border-t border-gray-200" />
          <div className="flex items-baseline justify-between gap-3 text-[11px] font-mono">
            <span className="text-fg-muted flex-1 [padding-left:2ch] [text-indent:-2ch] [text-wrap:balance]">
              {/* Hanging indent sized in `ch` units so the gutter is
                  exactly the width of "+ " (two monospace chars) —
                  wrapped lines align precisely under "3" rather than
                  drifting right of it. Non-breaking space keeps
                  "marketplace fee" together. */}
              + 3% Additional SuperRare marketplace&nbsp;fee
            </span>
            <span className="tabular-nums text-fg text-right whitespace-nowrap">
              {previewBid > 0n ? (
                <>
                  <span>{formatEthShort(premiumWei)} ETH</span>
                  {ethPriceUsd && (
                    <span className="text-gray-400">
                      {" "}({formatUsd(premiumWei, ethPriceUsd)})
                    </span>
                  )}
                </>
              ) : (
                <span>3%</span>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function BidSection({
  auction,
  bid,
}: {
  auction: AuctionState
  bid: ReturnType<typeof useEthAmountInput>
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
  const { data: balance } = useBalance({
    address,
    // Pin the balance read to the chain we'll send the tx on so the
    // displayed number matches what the user has available for bidding.
    chainId: PREFERRED_CHAIN.id,
    query: { enabled: !!address && !wrongNetwork },
  })
  const minBidWei = auction.minBidWei
  const minBidEth = formatEther(minBidWei)

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
  // After a confirmed bid, clear the input so it doesn't render the
  // user's now-stale bid amount alongside an "already highest bidder"
  // disabled button (the new minimum bid is current + BID_INCREASE,
  // so leaving the old value triggers a misleading "below minimum"
  // error). The success banner above the form provides the
  // confirmation; the form below resets to a clean empty state.
  useEffect(() => {
    if (isSuccess) bid.reset()
  }, [isSuccess, bid])

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
    } else if (auction.source === "transient") {
      // TL Auction House: msg.value carries the full bid amount; no
      // buyer's premium (the protocol fee is deducted from the seller
      // proceeds on settle, not added on top). `recipient` is who
      // receives the NFT if the bidder wins — usually the bidder
      // themselves (`address`).
      writeContract({
        address: auction.marketAddress,
        abi: transientAuctionHouseAbi,
        functionName: "bid",
        args: [
          auction.nftContract,
          BigInt(auction.tokenId),
          (address ?? ZERO_ADDRESS) as `0x${string}`,
          bid.wei,
        ],
        value: bid.wei,
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

  if (wrongNetwork) {
    return (
      <button
        type="button"
        onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
        disabled={isSwitchPending}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40"
      >
        {isSwitchPending ? "Switching…" : `Wrong network — switch to ${PREFERRED_CHAIN_LABEL}`}
      </button>
    )
  }

  return (
    <div className="space-y-2">
      {isSuccess && txHash && (
        <TxSuccessBanner
          txHash={txHash}
          message="Bid placed."
          onDismiss={reset}
        />
      )}
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
      <div className="flex items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={() => bid.setFromWei(minBidWei)}
          disabled={isPending}
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          title="Use minimum bid"
        >
          Minimum bid: {minBidEth} ETH
        </button>
        {balance && (
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
            Balance: {Number(formatEther(balance.value)).toFixed(3)} ETH
          </span>
        )}
      </div>

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
          {formatWriteError(writeError, "Bid")}
        </p>
      )}
    </div>
  )
}

function SettleSection({
  auction,
  onSettled,
}: {
  auction: AuctionState
  /**
   * Fires once the settle tx confirms, so the parent panel can flip
   * its header / status chrome to "Auction settled" while the success
   * banner is still on screen. Without this the panel chrome stays
   * stuck on "Awaiting settlement" until the user dismisses the banner
   * and triggers a refresh.
   */
  onSettled?: () => void
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
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

  // Settle removes the auction entirely; an auto-refresh would unmount
  // the panel (and the success banner) before the user can read it.
  // Skip auto-refresh and let the banner's dismiss button trigger the
  // reload manually.
  const router = useRouter()
  useRevalidateAuctionOnSuccess(isSuccess, auction, { autoRefresh: false })
  // Notify the parent so the panel header flips to "settled" state.
  useEffect(() => {
    if (isSuccess) onSettled?.()
  }, [isSuccess, onSettled])

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
    } else if (auction.source === "transient") {
      writeContract({
        address: auction.marketAddress,
        abi: transientAuctionHouseAbi,
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

  if (isSuccess && txHash) {
    return (
      <TxSuccessBanner
        txHash={txHash}
        message="Auction settled. NFT transferred to the winner."
        onDismiss={() => {
          reset()
          // Settle removed the auction; refresh now that the user has
          // acknowledged the success so the page transitions to the
          // post-auction state (no panel rendered).
          router.refresh()
        }}
      />
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

  if (wrongNetwork) {
    return (
      <button
        type="button"
        onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
        disabled={isSwitchPending}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40"
      >
        {isSwitchPending ? "Switching…" : `Wrong network — switch to ${PREFERRED_CHAIN_LABEL}`}
      </button>
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
          {formatWriteError(writeError, "Settle")}
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
function SellerActions({
  auction,
  onCancelled,
}: {
  auction: AuctionState
  onCancelled?: () => void
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
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

  // Both seller actions invalidate the cached auction state. Cancel
  // deletes the auction (panel will unmount on refresh — defer); update
  // changes the surfaced "Reserve" number (panel survives so safe to
  // auto-refresh, but for consistency we treat both as user-dismissed).
  const sellerRouter = useRouter()
  useRevalidateAuctionOnSuccess(cancelSuccess || updateSuccess, auction, {
    autoRefresh: false,
  })
  // Tell the parent panel to flip its header to "Auction cancelled"
  // while the success banner is still visible. (Update doesn't
  // affect the lifecycle phase — the auction is still live with a
  // new reserve — so we don't fire on updateSuccess.)
  useEffect(() => {
    if (cancelSuccess) onCancelled?.()
  }, [cancelSuccess, onCancelled])

  if (!isSeller) return null

  if (wrongNetwork) {
    return (
      <button
        type="button"
        onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
        disabled={isSwitchPending}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40"
      >
        {isSwitchPending ? "Switching…" : `Wrong network — switch to ${PREFERRED_CHAIN_LABEL}`}
      </button>
    )
  }

  if ((cancelSuccess && cancelHash) || (updateSuccess && updateHash)) {
    const hash = cancelSuccess ? cancelHash! : updateHash!
    const message = cancelSuccess
      ? "Auction cancelled."
      : "Reserve updated."
    return (
      <TxSuccessBanner
        txHash={hash}
        message={message}
        onDismiss={() => {
          resetCancel()
          resetUpdate()
          sellerRouter.refresh()
        }}
      />
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
    } else if (auction.source === "transient") {
      // TL exposes the cancel-listing call as `delist` (covers
      // auction + buy-now). Same (nftAddress, tokenId) signature.
      writeCancel({
        address: auction.marketAddress,
        abi: transientAuctionHouseAbi,
        functionName: "delist",
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
          {auction.source === "superrareV2" || auction.source === "transient" ? (
            // SR Bazaar and TL Auction House both lack an update-
            // reserve call on a live listing; only cancel/delist is
            // available pre-bid.
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
          {formatWriteError(
            (cancelError || updateError)!,
            cancelError ? "Cancel" : "Update",
          )}
        </p>
      )}
    </div>
  )
}
