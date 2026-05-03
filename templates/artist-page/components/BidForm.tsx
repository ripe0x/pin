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
import { formatEth } from "@/lib/format"

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
}

/**
 * Client-side bid + settle controls. Polls the on-chain `auctions(id)`
 * struct every block (~12s) for live state. After a successful tx, it
 * watches the receipt and refetches to reflect the new state.
 */
export function BidForm({ houseAddress, auctionId, initial }: Props) {
  const { address: connected, isConnected } = useAccount()

  // Live read of the auction struct. Refetches every block.
  const auctionRead = useReadContract({
    address: houseAddress,
    abi: sovereignAuctionHouseAbi,
    functionName: "auctions",
    args: [BigInt(auctionId)],
    query: {
      // Hydrate from server-rendered initial state so the first render
      // has the right values without flickering.
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

  // Refetch after a confirmed tx.
  useEffect(() => {
    if (confirmed) {
      auctionRead.refetch()
      minBidRead.refetch()
    }
  }, [confirmed]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isCancelled) {
    return (
      <Box>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          This auction was cancelled.
        </p>
      </Box>
    )
  }

  if (ended) {
    return (
      <Box>
        <div className="flex items-center justify-between">
          <span className="text-sm text-[hsl(var(--muted-foreground))]">
            Auction ended
          </span>
          <span className="font-mono text-sm">
            {formatEth(amount.toString())} ETH
          </span>
        </div>
        <SettleButton
          houseAddress={houseAddress}
          auctionId={auctionId}
          isConnected={isConnected}
          isPending={isPending}
          confirming={confirming}
          writeContract={writeContract}
        />
        {writeError ? <ErrorLine error={writeError} /> : null}
      </Box>
    )
  }

  const remainingSec = Number(endTime) - nowSec
  return (
    <Box>
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-[hsl(var(--muted-foreground))]">
          {awaitingFirstBid ? "Reserve price" : "Current bid"}
        </span>
        <span className="font-mono text-base font-medium">
          {formatEth(awaitingFirstBid ? reservePrice.toString() : amount.toString())} ETH
        </span>
      </div>
      {!awaitingFirstBid && remainingSec > 0 ? (
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-[hsl(var(--muted-foreground))]">
            Time remaining
          </span>
          <span className="font-mono text-sm">
            <CountdownLabel target={Number(endTime)} />
          </span>
        </div>
      ) : null}
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
    </Box>
  )
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))] p-5">
      {children}
    </div>
  )
}

function ErrorLine({ error }: { error: Error }) {
  // Surface the most useful slice of viem error messages without dumping
  // the full stacktrace at the visitor.
  const msg = (error.message ?? "").split("\n")[0]
  return (
    <p className="text-sm text-red-500" role="alert">
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
      <div className="mt-2">
        <RKConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              type="button"
              onClick={openConnectModal}
              className="w-full rounded-md bg-[hsl(var(--accent))] px-4 py-2.5 text-sm font-medium text-[hsl(var(--accent-foreground))] hover:opacity-90"
            >
              Connect wallet to bid
            </button>
          )}
        </RKConnectButton.Custom>
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <label className="flex items-center gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2">
        <input
          type="number"
          inputMode="decimal"
          step="0.001"
          min={minEth}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 bg-transparent font-mono text-base outline-none"
          aria-label="Bid amount in ETH"
        />
        <span className="text-sm text-[hsl(var(--muted-foreground))]">ETH</span>
      </label>
      <button
        type="button"
        onClick={submit}
        disabled={tooLow || isPending || confirming}
        className="w-full rounded-md bg-[hsl(var(--accent))] px-4 py-2.5 text-sm font-medium text-[hsl(var(--accent-foreground))] disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-90"
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
      <div className="mt-2">
        <RKConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              type="button"
              onClick={openConnectModal}
              className="w-full rounded-md bg-[hsl(var(--accent))] px-4 py-2.5 text-sm font-medium text-[hsl(var(--accent-foreground))] hover:opacity-90"
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
      className="mt-2 w-full rounded-md bg-[hsl(var(--accent))] px-4 py-2.5 text-sm font-medium text-[hsl(var(--accent-foreground))] disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-90"
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
