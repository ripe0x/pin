"use client"

import { useEffect, useState } from "react"
import { type Address, formatEther } from "viem"
import {
  useAccount,
  useBalance,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton as RKConnectButton } from "@rainbow-me/rainbowkit"
import { surfaceAbi } from "@/lib/abi"
import { CollectionStatus, isMintable } from "@/lib/surface"
import type { CollectionConfig } from "@/lib/surface"

/**
 * `CollectionConfig` with every bigint field as a decimal string. Next.js
 * can't serialize a raw `bigint` across the server/client component
 * boundary (it throws "Do not know how to serialize a BigInt" from the RSC
 * payload encoder) — every other bigint crossing that boundary elsewhere in
 * this template already goes through a string (see AuctionSummary in
 * lib/auctions.ts), so `initial.cfg` follows the same convention.
 */
export type SerializedCollectionConfig = Omit<
  CollectionConfig,
  "price" | "supplyCap" | "mintStart" | "mintEnd"
> & {
  price: string
  supplyCap: string
  mintStart: string
  mintEnd: string
}

function deserializeCfg(cfg: SerializedCollectionConfig): CollectionConfig {
  return {
    ...cfg,
    price: BigInt(cfg.price),
    supplyCap: BigInt(cfg.supplyCap),
    mintStart: BigInt(cfg.mintStart),
    mintEnd: BigInt(cfg.mintEnd),
  }
}

type Props = {
  collectionAddress: Address
  /** The artist's own wallet — see the surface-share comment on MintButton below. */
  artistAddress: Address
  /** Server-rendered initial state for fast first paint. */
  initial: {
    name: string
    cfg: SerializedCollectionConfig
    status: CollectionStatus
    minted: string
    /** Pre-connect price estimate for quantity 1, or null if unreadable. */
    price: string | null
  }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/**
 * Mint card for the artist's optional Surface. Mirrors BidForm's
 * chrome (status dot + big tabular-nums price + a single primary action) so
 * the collection surface reads as part of the same visual family as the
 * auction panel, even though the underlying protocol is entirely different.
 *
 * Only rendered when `NEXT_PUBLIC_COLLECTION_ADDRESS` is configured — see
 * lib/config.ts and app/page.tsx.
 */
export function CollectionMintCard({ collectionAddress, artistAddress, initial }: Props) {
  const { address: connected, isConnected } = useAccount()

  // No `initialData` seeding here, same reasoning as BidForm: a server
  // snapshot treated as "already fetched" data can stick past a mint that
  // happened after the last ISR revalidation. The live read is the single
  // source of truth; `initial.*` only covers the gap until it resolves.
  const configRead = useReadContract({
    address: collectionAddress,
    abi: surfaceAbi,
    functionName: "config",
    query: {
      refetchInterval: 12_000,
      refetchIntervalInBackground: true,
    },
  })

  const tuple = configRead.data as
    | readonly [CollectionConfig, number, bigint]
    | undefined
  const cfg = tuple?.[0] ?? deserializeCfg(initial.cfg)
  const status = (tuple?.[1] ?? initial.status) as CollectionStatus
  const minted = tuple?.[2] ?? BigInt(initial.minted)

  const priceRead = useReadContract({
    address: collectionAddress,
    abi: surfaceAbi,
    functionName: "currentPrice",
    args: [connected ?? ZERO_ADDRESS, 1n, "0x"],
    query: { refetchInterval: 12_000, refetchIntervalInBackground: true },
  })
  const priceWei =
    (priceRead.data as bigint | undefined) ??
    (initial.price !== null ? BigInt(initial.price) : cfg.price)

  const { writeContract, data: txHash, isPending, error: writeError } =
    useWriteContract()
  const { isLoading: confirming, isSuccess: confirmed } =
    useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (confirmed) {
      configRead.refetch()
      priceRead.refetch()
    }
  }, [confirmed]) // eslint-disable-line react-hooks/exhaustive-deps

  const nowSec = useNowSec()
  const notStarted = cfg.mintStart > 0n && BigInt(nowSec) < cfg.mintStart
  const remaining = cfg.supplyCap > 0n ? cfg.supplyCap - minted : null
  const soldOut = remaining !== null && remaining <= 0n
  const mintable =
    !notStarted && isMintable(cfg, minted, nowSec) && status !== CollectionStatus.Closed

  const statusLabel = notStarted
    ? "Not open yet"
    : soldOut
      ? "Sold out"
      : status === CollectionStatus.Closed
        ? "Closed"
        : status === CollectionStatus.Closing
          ? "Closing soon"
          : "Open"
  const statusDot = mintable
    ? status === CollectionStatus.Closing
      ? "bg-status-upcoming"
      : "bg-status-live animate-pulse"
    : "bg-gray-400"

  const balanceQuery = useBalance({
    address: connected,
    query: { enabled: Boolean(connected), refetchInterval: 12_000 },
  })
  const balanceWei = balanceQuery.data?.value ?? 0n
  const insufficient = balanceQuery.isSuccess && priceWei > balanceWei

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
          <div className="text-right">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              Minted
            </p>
            <p className="text-sm font-mono tabular-nums leading-none text-gray-500">
              {minted.toString()}
              {cfg.supplyCap > 0n ? ` / ${cfg.supplyCap.toString()}` : ""}
            </p>
          </div>
        </div>

        <PriceRow priceWei={priceWei} />

        <MintButton
          collectionAddress={collectionAddress}
          artistAddress={artistAddress}
          mintable={mintable}
          isConnected={isConnected}
          isPending={isPending}
          confirming={confirming}
          insufficient={insufficient}
          balanceWei={balanceWei}
          writeContract={writeContract}
        />
        {writeError ? <ErrorLine error={writeError} /> : null}
      </div>
    </div>
  )
}

function PriceRow({ priceWei }: { priceWei: bigint }) {
  const gasOnly = priceWei === 0n
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        Price
      </p>
      <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
        {gasOnly ? (
          "Gas only"
        ) : (
          <>
            {trimEth(formatEther(priceWei))}{" "}
            <span className="text-sm font-mono text-gray-500">ETH</span>
          </>
        )}
      </p>
    </div>
  )
}

function trimEth(s: string): string {
  if (!s.includes(".")) return s
  return s.replace(/\.?0+$/, "")
}

type WriteContractFn = ReturnType<typeof useWriteContract>["writeContract"]

function MintButton({
  collectionAddress,
  artistAddress,
  mintable,
  isConnected,
  isPending,
  confirming,
  insufficient,
  balanceWei,
  writeContract,
}: {
  collectionAddress: Address
  artistAddress: Address
  mintable: boolean
  isConnected: boolean
  isPending: boolean
  confirming: boolean
  insufficient: boolean
  balanceWei: bigint
  writeContract: WriteContractFn
}) {
  if (!isConnected) {
    return (
      <RKConnectButton.Custom>
        {({ openConnectModal }) => (
          <button
            type="button"
            onClick={openConnectModal}
            className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-opacity"
          >
            Connect wallet to mint
          </button>
        )}
      </RKConnectButton.Custom>
    )
  }

  function submit() {
    // `surface` is passed as the artist's own address, not PND's. On PND's
    // main site, mints surfaced there pay PND's surface share; on the
    // artist's own self-hosted page, the artist IS the surface — passing
    // their own address here means the surface-share cut lands back with
    // the artist instead of anyone else. That's the whole point of a
    // self-hosted mint card.
    writeContract({
      address: collectionAddress,
      abi: surfaceAbi,
      functionName: "mintWithRewards",
      args: [1n, artistAddress, "0x"],
    })
  }

  const disabled = !mintable || isPending || confirming || insufficient

  return (
    <button
      type="button"
      onClick={submit}
      disabled={disabled}
      className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-80 transition-opacity"
    >
      {confirming
        ? "Waiting for confirmation…"
        : isPending
          ? "Confirm in wallet…"
          : !mintable
            ? "Minting closed"
            : insufficient
              ? `Insufficient balance · ${trimEth(formatEther(balanceWei))} ETH available`
              : "Mint"}
    </button>
  )
}

function ErrorLine({ error }: { error: Error }) {
  const msg = (error.message ?? "").split("\n")[0]
  return (
    <p className="text-[11px] font-mono text-status-sold" role="alert">
      {msg || "Transaction failed."}
    </p>
  )
}

function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}
