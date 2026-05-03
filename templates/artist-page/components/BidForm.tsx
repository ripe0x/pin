"use client"

import { useEffect, useMemo, useState } from "react"
import { type Address, formatEther, parseEther } from "viem"
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton as RKConnectButton } from "@rainbow-me/rainbowkit"
import { sovereignAuctionHouseAbi } from "@/lib/abi"
import { ZERO_ADDRESS } from "@/lib/config"
import { displayFor, formatEth } from "@/lib/format"

type Props = {
  houseAddress: Address
  auctionId: string
  /** Server-rendered initial state for fast first paint. */
  initial: {
    amount: string
    endTime: string
    reservePrice: string
    bidder: Address
    firstBidTime: string
    tokenOwner: Address
  }
  /** Pre-resolved ENS map for any addresses we'll display. */
  ensMap?: Map<string, string>
}

/**
 * Live bid + settle panel. Mirrors PND's bid panel chrome from
 * `SettledAuctionSummary` (status header + big tabular-nums price) so
 * pre-bid, mid-auction, and settled all read as one visual family.
 */
export function BidForm({ houseAddress, auctionId, initial, ensMap }: Props) {
  const { address: connected, isConnected } = useAccount()

  const auctionRead = useReadContract({
    address: houseAddress,
    abi: sovereignAuctionHouseAbi,
    functionName: "auctions",
    args: [BigInt(auctionId)],
    query: {
      initialData: [
        0n,
        ZERO_ADDRESS as Address,
        BigInt(initial.firstBidTime),
        BigInt(initial.amount),
        BigInt(initial.reservePrice),
        initial.tokenOwner,
        BigInt(initial.endTime),
        initial.bidder,
        0n,
      ] as readonly [
        bigint, Address, bigint, bigint, bigint, Address, bigint, Address, bigint,
      ],
      refetchInterval: 12_000,
    },
  })

  const tuple = auctionRead.data as readonly [
    bigint, Address, bigint, bigint, bigint, Address, bigint, Address, bigint,
  ] | undefined
  const amount = tuple?.[3] ?? BigInt(initial.amount)
  const reservePrice = tuple?.[4] ?? BigInt(initial.reservePrice)
  const tokenOwner = (tuple?.[5] ?? initial.tokenOwner) as Address
  const endTime = tuple?.[6] ?? BigInt(initial.endTime)
  const bidder = (tuple?.[7] ?? initial.bidder) as Address
  const firstBidTime = tuple?.[2] ?? BigInt(initial.firstBidTime)

  const minBidRead = useReadContract({
    address: houseAddress,
    abi: sovereignAuctionHouseAbi,
    functionName: "getMinBidAmount",
    args: [BigInt(auctionId)],
    query: { refetchInterval: 12_000 },
  })
  const minBidWei =
    (minBidRead.data as readonly [boolean, bigint] | undefined)?.[1] ??
    (amount === 0n ? reservePrice : amount)

  const isCancelled = tokenOwner === ZERO_ADDRESS
  const awaitingFirstBid = firstBidTime === 0n || bidder === ZERO_ADDRESS
  const nowSec = useNowSec()
  const ended = !awaitingFirstBid && endTime > 0n && BigInt(nowSec) >= endTime

  const { writeContract, data: txHash, isPending, error: writeError } =
    useWriteContract()
  const { isLoading: confirming, isSuccess: confirmed } =
    useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (confirmed) {
      auctionRead.refetch()
      minBidRead.refetch()
    }
  }, [confirmed]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isCancelled) {
    return (
      <Panel statusDot="bg-gray-400" statusLabel="Cancelled">
        <p className="text-[11px] font-mono text-gray-500">
          This auction was cancelled.
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
          subtext={
            bidder !== ZERO_ADDRESS
              ? `by ${displayFor(bidder, ensMap)}`
              : undefined
          }
        />
        <SettleButton
          houseAddress={houseAddress}
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
        subtext={
          showBidder ? `by ${displayFor(bidder, ensMap)}` : undefined
        }
      />
      <BidInput
        houseAddress={houseAddress}
        auctionId={auctionId}
        minBidWei={minBidWei}
        isConnected={isConnected}
        connected={connected}
        isPending={isPending}
        confirming={confirming}
        writeContract={writeContract}
      />
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
    <div className="rounded-md border border-gray-200 bg-surface overflow-hidden">
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
  subtext,
}: {
  label: string
  amountWei: bigint
  subtext?: string
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        {label}
      </p>
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

function ErrorLine({ error }: { error: Error }) {
  const msg = (error.message ?? "").split("\n")[0]
  return (
    <p
      className="text-[11px] font-mono text-status-sold"
      role="alert"
    >
      {msg || "Transaction failed."}
    </p>
  )
}

type WriteContractFn = ReturnType<typeof useWriteContract>["writeContract"]

function BidInput({
  houseAddress,
  auctionId,
  minBidWei,
  isConnected,
  connected,
  isPending,
  confirming,
  writeContract,
}: {
  houseAddress: Address
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

  function submit() {
    if (tooLow) return
    writeContract({
      address: houseAddress,
      abi: sovereignAuctionHouseAbi,
      functionName: "createBid",
      args: [BigInt(auctionId)],
      value: parsed,
    })
  }

  if (!isConnected || !connected) {
    return (
      <div className="pt-2">
        <RKConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              type="button"
              onClick={openConnectModal}
              className="w-full rounded-md border border-fg bg-fg px-4 py-2.5 text-sm font-medium text-bg hover:opacity-90 transition-opacity"
            >
              Connect wallet to bid
            </button>
          )}
        </RKConnectButton.Custom>
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
        disabled={tooLow || isPending || confirming}
        className="w-full rounded-md border border-fg bg-fg px-4 py-2.5 text-sm font-medium text-bg disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-90 transition-opacity"
      >
        {confirming
          ? "Waiting for confirmation…"
          : isPending
            ? "Confirm in wallet…"
            : tooLow
              ? `Min bid ${formatEth(minBidWei.toString())} ETH`
              : "Place bid"}
      </button>
    </div>
  )
}

function SettleButton({
  houseAddress,
  auctionId,
  isConnected,
  isPending,
  confirming,
  writeContract,
}: {
  houseAddress: Address
  auctionId: string
  isConnected: boolean
  isPending: boolean
  confirming: boolean
  writeContract: WriteContractFn
}) {
  if (!isConnected) {
    return (
      <div className="pt-2">
        <RKConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              type="button"
              onClick={openConnectModal}
              className="w-full rounded-md border border-fg bg-fg px-4 py-2.5 text-sm font-medium text-bg hover:opacity-90 transition-opacity"
            >
              Connect wallet to settle
            </button>
          )}
        </RKConnectButton.Custom>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() =>
        writeContract({
          address: houseAddress,
          abi: sovereignAuctionHouseAbi,
          functionName: "endAuction",
          args: [BigInt(auctionId)],
        })
      }
      disabled={isPending || confirming}
      className="mt-2 w-full rounded-md border border-fg bg-fg px-4 py-2.5 text-sm font-medium text-bg disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-90 transition-opacity"
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
