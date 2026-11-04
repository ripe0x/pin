"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { type Address, formatEther, parseEther } from "viem"
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton as RKConnectButton } from "@rainbow-me/rainbowkit"
import { sovereignAuctionHouseAbi, sovereignAuctionHouseV2Abi } from "@/lib/abi"
import { ZERO_ADDRESS } from "@/lib/config"
import { displayFor, formatEth } from "@/lib/format"
import type { HouseVersion, TokenStandard } from "@/lib/auctions"
import {
  ERC1155_SETTLEMENT_NOTE,
  V1_BID_STANDS_NOTE,
  V1_BIDS_PAUSED_NOTICE,
  canBid,
  showsSettlementDelayNote,
} from "@/lib/auction-policy"
import {
  AUCTION_CHAIN_ID,
  buildBidRequest,
  buildSettleRequest,
  describeBidError,
} from "@/lib/bid-transaction"

// Mirrors `uint16 public constant MIN_BID_INCREMENT_BPS = 500;` on the V2
// house, which has no min-bid view, so the increment is computed here. Only
// V2 houses take bids from this site (lib/auction-policy.ts).
const MIN_BID_INCREMENT_BPS = 500n

function computeMinBid(amount: bigint, reservePrice: bigint): bigint {
  if (amount === 0n) return reservePrice
  const increment = (amount * MIN_BID_INCREMENT_BPS) / 10_000n
  return amount + (increment === 0n ? 1n : increment)
}

type Props = {
  houseAddress: Address
  houseVersion: HouseVersion
  auctionId: string
  /** Server-rendered initial state for fast first paint. */
  initial: {
    amount: string
    endTime: string
    reservePrice: string
    bidder: Address
    firstBidTime: string
    tokenOwner: Address
    standard: TokenStandard
    quantity: string
    listingExpiry: string
  }
  /** Pre-resolved ENS map for any addresses we'll display. */
  ensMap?: Map<string, string>
}

/**
 * Live bid + settle panel. Bids are offered on V2 houses only: a V1 house
 * listing shows a paused notice in place of the bid box, but still settles
 * here once it has ended with a bid (lib/auction-policy.ts).
 *
 * Mirrors PND's bid panel chrome from
 * `SettledAuctionSummary` (status header + big tabular-nums price) so
 * pre-bid, mid-auction, and settled all read as one visual family.
 *
 * Only renders for auction status "live" or "upcoming". The caller routes
 * "deferred"/"unwound_return_pending" to DeferredLotCard and
 * "settled"/"cancelled"/"unwound" to SettledSummary instead. A V2 auction
 * can still transition into "deferred" while this panel is mounted (its
 * settlement delivery fails after someone calls endAuction); the poll below
 * detects that and refreshes the page so the server re-renders the correct
 * panel.
 */
export function BidForm({ houseAddress, houseVersion, auctionId, initial, ensMap }: Props) {
  const { address: connected, isConnected } = useAccount()
  const router = useRouter()
  const refreshedFinalState = useRef(false)
  const refreshedDeferredState = useRef(false)
  const abi = houseVersion === 2 ? sovereignAuctionHouseV2Abi : sovereignAuctionHouseAbi

  // No `initialData` here on purpose: seeding the query with the
  // server-rendered tuple makes react-query treat it as already-fetched and
  // it can stick on that stale seed (e.g. a bid placed after the page's last
  // ISR revalidation would never flip "awaiting first bid" → "live"). We let
  // the live read be the single source of truth and fall back to the server
  // `initial.*` values below only until the first fetch resolves.
  const auctionRead = useReadContract({
    chainId: AUCTION_CHAIN_ID,
    address: houseAddress,
    abi,
    functionName: "auctions",
    args: [BigInt(auctionId)],
    query: {
      refetchInterval: 12_000,
      // Keep polling while the tab is backgrounded — during the wallet
      // popup / tx confirmation the tab loses focus, and without this the
      // 12s interval pauses, so a freshly placed bid wouldn't reflect until
      // the user refocused. One extra poll during an active bid is cheap.
      refetchIntervalInBackground: true,
    },
  })

  // V1's tuple is [tokenId, tokenContract, firstBidTime, amount,
  // reservePrice, tokenOwner, endTime, bidder, duration]. V2 inserts
  // fundsRecipient before endTime and appends quantity + standard, so
  // endTime/bidder shift by one index.
  const tuple = auctionRead.data as readonly unknown[] | undefined
  const amount = (tuple?.[3] as bigint | undefined) ?? BigInt(initial.amount)
  const reservePrice = (tuple?.[4] as bigint | undefined) ?? BigInt(initial.reservePrice)
  const tokenOwner = ((tuple?.[5] as Address | undefined) ?? initial.tokenOwner) as Address
  const endTime =
    (tuple?.[houseVersion === 2 ? 7 : 6] as bigint | undefined) ?? BigInt(initial.endTime)
  const bidder = ((tuple?.[houseVersion === 2 ? 8 : 7] as Address | undefined) ??
    initial.bidder) as Address
  const firstBidTime = (tuple?.[2] as bigint | undefined) ?? BigInt(initial.firstBidTime)

  const minBidWei = computeMinBid(amount, reservePrice)
  const refetchAuction = auctionRead.refetch

  // V2 only: a settlement delivery failure leaves `tokenOwner` populated
  // (unlike V1, where settling always deletes storage), so it never reads as
  // finalized here. Poll both flags in one multicall and hand off to
  // DeferredLotCard via a server refresh once either is set.
  const deferralFlags = useReadContracts({
    contracts: [
      {
        chainId: AUCTION_CHAIN_ID,
        address: houseAddress,
        abi: sovereignAuctionHouseV2Abi,
        functionName: "pendingDelivery",
        args: [BigInt(auctionId)],
      },
      {
        chainId: AUCTION_CHAIN_ID,
        address: houseAddress,
        abi: sovereignAuctionHouseV2Abi,
        functionName: "pendingReturn",
        args: [BigInt(auctionId)],
      },
    ],
    query: {
      enabled: houseVersion === 2,
      refetchInterval: 12_000,
      refetchIntervalInBackground: true,
    },
  })
  const isDeferred =
    houseVersion === 2 &&
    (deferralFlags.data?.[0]?.result === true || deferralFlags.data?.[1]?.result === true)

  // Both settlement and cancellation delete the auction storage on V1. On
  // V2 the same is true once settlement actually completes; a deferred or
  // return-pending auction keeps its storage, which is why `isDeferred` is
  // checked separately above.
  const isFinalized = tokenOwner === ZERO_ADDRESS
  const awaitingFirstBid = firstBidTime === 0n || bidder === ZERO_ADDRESS
  const nowSec = useNowSec()
  const ended = !awaitingFirstBid && endTime > 0n && BigInt(nowSec) >= endTime
  const listingExpired =
    houseVersion === 2 &&
    awaitingFirstBid &&
    initial.listingExpiry !== "0" &&
    nowSec >= Number(initial.listingExpiry)

  const { writeContract, data: txHash, isPending, error: writeError } =
    useWriteContract()
  const { isLoading: confirming, isSuccess: confirmed } =
    useWaitForTransactionReceipt({ hash: txHash, chainId: AUCTION_CHAIN_ID })

  useEffect(() => {
    if (confirmed) {
      refetchAuction()
      router.refresh()
    }
  }, [confirmed, refetchAuction, router])

  useEffect(() => {
    if (!isFinalized || refreshedFinalState.current) return
    refreshedFinalState.current = true
    router.refresh()
  }, [isFinalized, router])

  useEffect(() => {
    if (!isDeferred || refreshedDeferredState.current) return
    refreshedDeferredState.current = true
    router.refresh()
  }, [isDeferred, router])

  if (isFinalized) {
    return (
      <Panel statusDot="bg-status-upcoming" statusLabel="Auction complete">
        <p className="text-[11px] font-mono text-gray-500">
          Refreshing the final on-chain result…
        </p>
      </Panel>
    )
  }

  if (isDeferred) {
    return (
      <Panel statusDot="bg-status-upcoming" statusLabel="Settlement outcome pending">
        <p className="text-[11px] font-mono text-gray-500">
          Delivery failed at settlement. Refreshing…
        </p>
      </Panel>
    )
  }

  if (listingExpired) {
    return (
      <Panel statusDot="bg-gray-400" statusLabel="Listing expired">
        <p className="text-[11px] font-mono text-gray-500">
          This listing&rsquo;s no-bid window closed with no bids. The token stays
          escrowed until the seller cancels or relists it.
        </p>
      </Panel>
    )
  }

  if (ended) {
    return (
      <Panel statusDot="bg-status-upcoming" statusLabel="Awaiting settlement">
        <PriceRow
          label="Final bid"
          amountWei={amount}
          quantity={initial.standard === "erc1155" ? initial.quantity : undefined}
          subtext={
            bidder !== ZERO_ADDRESS
              ? `by ${displayFor(bidder, ensMap)}`
              : undefined
          }
        />
        <SettleButton
          houseAddress={houseAddress}
          houseVersion={houseVersion}
          auctionId={auctionId}
          isConnected={isConnected}
          isPending={isPending}
          confirming={confirming}
          writeContract={writeContract}
        />
        {writeError ? <ErrorLine error={writeError} /> : null}
      </Panel>
    )
  }

  const remainingSec = Number(endTime) - nowSec
  const showBidder = !awaitingFirstBid && bidder !== ZERO_ADDRESS

  return (
    <Panel
      statusDot={awaitingFirstBid ? "bg-status-upcoming" : "bg-status-live"}
      statusLabel={awaitingFirstBid ? "Awaiting first bid" : "Live auction"}
      rightLabel={!awaitingFirstBid && remainingSec > 0 ? "Time left" : undefined}
      rightValue={
        !awaitingFirstBid && remainingSec > 0 ? (
          <CountdownLabel target={Number(endTime)} />
        ) : undefined
      }
    >
      <PriceRow
        label={awaitingFirstBid ? "Reserve price" : "Current bid"}
        amountWei={awaitingFirstBid ? reservePrice : amount}
        quantity={initial.standard === "erc1155" ? initial.quantity : undefined}
        subtext={
          showBidder ? `by ${displayFor(bidder, ensMap)}` : undefined
        }
      />
      {canBid(houseVersion) ? (
        <BidInput
          houseAddress={houseAddress}
          houseVersion={houseVersion}
          auctionId={auctionId}
          minBidWei={minBidWei}
          isConnected={isConnected}
          connected={connected}
          isPending={isPending}
          confirming={confirming}
          writeContract={writeContract}
        />
      ) : (
        <BidsPausedNotice hasBid={!awaitingFirstBid} />
      )}
      {showsSettlementDelayNote({ houseVersion, standard: initial.standard }) ? (
        <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
          {ERC1155_SETTLEMENT_NOTE}
        </p>
      ) : null}
      {writeError ? <ErrorLine error={writeError} /> : null}
    </Panel>
  )
}

function Panel({
  statusDot,
  statusLabel,
  rightLabel,
  rightValue,
  children,
}: {
  statusDot: string
  statusLabel: string
  rightLabel?: string
  rightValue?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
      <div className="p-5 space-y-5">
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot}`} />
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
              {statusLabel}
            </span>
          </div>
          {rightLabel ? (
            <div className="text-right space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                {rightLabel}
              </p>
              <p className="text-sm font-mono tabular-nums leading-none text-gray-500">
                {rightValue}
              </p>
            </div>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  )
}

function PriceRow({
  label,
  amountWei,
  quantity,
  subtext,
}: {
  label: string
  amountWei: bigint
  /** ERC1155 lot size. Omitted (undefined) for ERC721. */
  quantity?: string
  subtext?: string
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          {label}
        </p>
        {quantity ? (
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Qty {quantity}
          </p>
        ) : null}
      </div>
      <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
        {formatEth(amountWei.toString())}{" "}
        <span className="text-sm font-mono text-gray-500">ETH</span>
      </p>
      {subtext ? (
        <p className="text-[11px] font-mono text-gray-500 pt-1">{subtext}</p>
      ) : null}
    </div>
  )
}

/**
 * Replaces the bid box on a V1 house listing (canBid() is false). A V1
 * auction that already has a bid keeps it and settles through SettleButton
 * once it ends.
 */
function BidsPausedNotice({ hasBid }: { hasBid: boolean }) {
  return (
    <div className="space-y-2 rounded-md border border-gray-200 bg-bg p-3">
      <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
        {V1_BIDS_PAUSED_NOTICE}
      </p>
      {hasBid ? (
        <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
          {V1_BID_STANDS_NOTE}
        </p>
      ) : null}
    </div>
  )
}

function ErrorLine({ error }: { error: unknown }) {
  return (
    <p
      className="text-[11px] font-mono text-status-sold break-words"
      role="alert"
    >
      {describeBidError(error)}
    </p>
  )
}

type WriteContractFn = ReturnType<typeof useWriteContract>["writeContract"]

/**
 * Shown in place of a write button when the wallet is on another chain:
 * every write is pinned to mainnet, so wagmi would reject it anyway.
 */
function SwitchNetworkButton({ action }: { action: string }) {
  const { switchChain, isPending: switching } = useSwitchChain()
  return (
    <button
      type="button"
      onClick={() => switchChain({ chainId: AUCTION_CHAIN_ID })}
      disabled={switching}
      className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-80 transition-opacity"
    >
      {switching ? "Switching…" : `Switch to Ethereum to ${action}`}
    </button>
  )
}

function BidInput({
  houseAddress,
  houseVersion,
  auctionId,
  minBidWei,
  isConnected,
  connected,
  isPending,
  confirming,
  writeContract,
}: {
  houseAddress: Address
  houseVersion: HouseVersion
  auctionId: string
  minBidWei: bigint
  isConnected: boolean
  connected?: Address
  isPending: boolean
  confirming: boolean
  writeContract: WriteContractFn
}) {
  const minEth = useMemo(() => formatEther(minBidWei), [minBidWei])
  const [value, setValue] = useState(minEth)
  useEffect(() => {
    setValue(minEth)
  }, [minEth])

  const parsed = useMemo(() => {
    try {
      return parseEther(value as `${number}`)
    } catch {
      return 0n
    }
  }, [value])
  const tooLow = parsed < minBidWei

  const publicClient = usePublicClient({ chainId: AUCTION_CHAIN_ID })
  const { chainId } = useAccount()
  const wrongNetwork = Boolean(connected) && chainId !== AUCTION_CHAIN_ID

  const balanceQuery = useBalance({
    address: connected,
    chainId: AUCTION_CHAIN_ID,
    query: { enabled: Boolean(connected), refetchInterval: 12_000 },
  })
  const balanceWei = balanceQuery.data?.value ?? 0n
  const balanceLoaded = balanceQuery.isSuccess
  const insufficient = balanceLoaded && parsed > balanceWei

  const [simulating, setSimulating] = useState(false)
  const [simError, setSimError] = useState<unknown>(null)

  async function submit() {
    if (tooLow || insufficient || !publicClient || !connected) return
    const request = buildBidRequest({
      house: houseAddress,
      houseVersion,
      auctionId,
      value: parsed,
    })
    if (!request) return
    setSimError(null)
    setSimulating(true)
    try {
      // Simulate before asking the wallet to send ETH: a bid that would
      // revert (outbid since the page loaded, below the minimum raise,
      // auction already over) shows its reason here instead of costing gas.
      // The public client is pinned to mainnet; chainId rides on the write.
      const { address, abi, functionName, args, value } = request
      await publicClient.simulateContract({
        account: connected,
        address,
        abi,
        functionName,
        args,
        value,
      })
      writeContract(request)
    } catch (err) {
      setSimError(err)
    } finally {
      setSimulating(false)
    }
  }

  if (!isConnected || !connected) {
    return (
      <div className="pt-2">
        <RKConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              type="button"
              onClick={openConnectModal}
              className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-opacity"
            >
              Connect wallet to bid
            </button>
          )}
        </RKConnectButton.Custom>
      </div>
    )
  }

  if (wrongNetwork) {
    return (
      <div className="pt-2">
        <SwitchNetworkButton action="bid" />
      </div>
    )
  }

  return (
    <div className="pt-2 space-y-2">
      <label className="flex items-center gap-2 rounded-md border border-gray-200 bg-bg px-3 py-2 focus-within:border-gray-400 transition-colors">
        <input
          type="number"
          inputMode="decimal"
          step="0.001"
          min={minEth}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 bg-transparent font-mono text-base outline-none tabular-nums"
          aria-label="Bid amount in ETH"
        />
        <span className="font-mono text-xs text-gray-500">ETH</span>
      </label>
      <button
        type="button"
        onClick={submit}
        disabled={tooLow || insufficient || simulating || isPending || confirming}
        className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-80 transition-opacity"
      >
        {confirming
          ? "Waiting for confirmation…"
          : isPending
            ? "Confirm in wallet…"
            : simulating
              ? "Checking bid…"
              : tooLow
                ? `Min bid ${formatEth(minBidWei.toString())} ETH`
                : insufficient
                  ? `Insufficient balance · ${formatEth(balanceWei.toString())} ETH available`
                  : "Place bid"}
      </button>
      {simError ? <ErrorLine error={simError} /> : null}
    </div>
  )
}

function SettleButton({
  houseAddress,
  houseVersion,
  auctionId,
  isConnected,
  isPending,
  confirming,
  writeContract,
}: {
  houseAddress: Address
  houseVersion: HouseVersion
  auctionId: string
  isConnected: boolean
  isPending: boolean
  confirming: boolean
  writeContract: WriteContractFn
}) {
  const { chainId } = useAccount()
  const wrongNetwork = isConnected && chainId !== AUCTION_CHAIN_ID
  if (!isConnected) {
    return (
      <div className="pt-2">
        <RKConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              type="button"
              onClick={openConnectModal}
              className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-opacity"
            >
              Connect wallet to settle
            </button>
          )}
        </RKConnectButton.Custom>
      </div>
    )
  }
  if (wrongNetwork) {
    return (
      <div className="pt-2">
        <SwitchNetworkButton action="settle" />
      </div>
    )
  }
  // Settlement stays open on both house generations: a V1 auction that
  // already has a bid must still settle. (Two branches only so each write
  // narrows to one house ABI.)
  function settle() {
    const request = buildSettleRequest({ house: houseAddress, houseVersion, auctionId })
    if (request.abi === sovereignAuctionHouseV2Abi) {
      writeContract({ ...request, abi: sovereignAuctionHouseV2Abi })
    } else {
      writeContract({ ...request, abi: sovereignAuctionHouseAbi })
    }
  }
  return (
    <button
      type="button"
      onClick={settle}
      disabled={isPending || confirming}
      className="mt-2 block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-80 transition-opacity"
    >
      {confirming
        ? "Waiting for confirmation…"
        : isPending
          ? "Confirm in wallet…"
          : "Settle auction"}
    </button>
  )
}

function CountdownLabel({ target }: { target: number }) {
  const now = useNowSec()
  const remaining = Math.max(0, target - now)
  const d = Math.floor(remaining / 86400)
  const h = Math.floor((remaining % 86400) / 3600)
  const m = Math.floor((remaining % 3600) / 60)
  const s = remaining % 60
  if (remaining === 0) return <>Ended</>
  if (d > 0) return <>{`${d}d ${h}h ${m}m`}</>
  if (h > 0) return <>{`${h}h ${m}m ${s}s`}</>
  return <>{`${m}m ${s}s`}</>
}

function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}
