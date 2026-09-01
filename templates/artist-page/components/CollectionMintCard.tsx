"use client"

import { useEffect, useState } from "react"
import { formatEther, type Address, type Hex } from "viem"
import {
  useAccount,
  useBalance,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton as RKConnectButton } from "@rainbow-me/rainbowkit"
import { formatWriteError, prepareFixedPriceMint, SurfaceStatus } from "@pin/surface-kit"
import { fixedPriceMinterAbi, surfaceAbi } from "@/lib/abi"
import {
  decodeCollectionConfig,
  isMintable,
  lifecycleStatus,
  saleWindowOf,
  type CollectionConfig,
  type MinterSaleConfig,
  type RawCollectionConfig,
} from "@/lib/surface"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
const ZERO_ROOT = `0x${"0".repeat(64)}`

export type SerializedCollectionConfig = Omit<CollectionConfig, "supplyCap"> & {
  supplyCap: string
}

export type SerializedMinterSale = Omit<
  MinterSaleConfig,
  "price" | "mintStart" | "mintEnd" | "maxMints" | "totalMinted" | "walletCap"
> & {
  price: string
  mintStart: string
  mintEnd: string
  maxMints: string
  totalMinted: string
  walletCap: string
}

type Props = {
  collectionAddress: Address
  artistAddress: Address
  initial: {
    name: string
    cfg: SerializedCollectionConfig
    primaryMinter: Address | null
    sale: SerializedMinterSale | null
    minted: string
    price: string | null
  }
}

function deserializeCfg(cfg: SerializedCollectionConfig): CollectionConfig {
  return { ...cfg, supplyCap: BigInt(cfg.supplyCap) }
}

function deserializeSale(sale: SerializedMinterSale): MinterSaleConfig {
  return {
    ...sale,
    price: BigInt(sale.price),
    mintStart: BigInt(sale.mintStart),
    mintEnd: BigInt(sale.mintEnd),
    maxMints: BigInt(sale.maxMints),
    totalMinted: BigInt(sale.totalMinted),
    walletCap: BigInt(sale.walletCap),
  }
}

export function CollectionMintCard({ collectionAddress, artistAddress, initial }: Props) {
  const { address: connected, isConnected } = useAccount()
  const recipient = connected ?? artistAddress
  const [localError, setLocalError] = useState<string | null>(null)
  const [priceConfirmPending, setPriceConfirmPending] = useState(false)

  const configRead = useReadContract({
    address: collectionAddress,
    abi: surfaceAbi,
    functionName: "config",
    query: { refetchInterval: 12_000, refetchIntervalInBackground: true },
  })
  const primaryMinterRead = useReadContract({
    address: collectionAddress,
    abi: surfaceAbi,
    functionName: "primaryMinter",
    query: { refetchInterval: 30_000, refetchIntervalInBackground: false },
  })

  const liveTuple = configRead.data as readonly [RawCollectionConfig, bigint] | undefined
  const cfg = liveTuple ? decodeCollectionConfig(liveTuple[0]) : deserializeCfg(initial.cfg)
  const minted = liveTuple?.[1] ?? BigInt(initial.minted)
  const livePrimary = primaryMinterRead.data as Address | undefined
  const minter = livePrimary === undefined
    ? initial.primaryMinter
    : livePrimary.toLowerCase() === ZERO_ADDRESS
      ? null
      : livePrimary
  const initialSale = initial.sale ? deserializeSale(initial.sale) : null
  const fallbackSale = minter && initial.primaryMinter
    && minter.toLowerCase() === initial.primaryMinter.toLowerCase()
      ? initialSale
      : null

  const saleRead = useReadContracts({
    contracts: minter
      ? [
          { address: minter, abi: fixedPriceMinterAbi, functionName: "priceOf", args: [recipient, 1n] },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "price" },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "priceStrategy" },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "mintStart" },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "mintEnd" },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "maxMints" },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "totalMinted" },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "allowlistRoot" },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "walletCap" },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "referralShareBps" },
          { address: minter, abi: fixedPriceMinterAbi, functionName: "mintedBy", args: [recipient] },
        ]
      : [],
    allowFailure: true,
    query: { enabled: Boolean(minter), refetchInterval: 12_000, refetchIntervalInBackground: true },
  })

  const live = saleRead.data
  const result = <T,>(index: number): T | undefined => live?.[index]?.status === "success"
    ? live[index].result as T
    : undefined
  const sale: MinterSaleConfig | null = minter
    ? {
        minter,
        price: result<bigint>(1) ?? fallbackSale?.price ?? 0n,
        priceStrategy: result<Address>(2) ?? fallbackSale?.priceStrategy ?? ZERO_ADDRESS,
        mintStart: result<bigint>(3) ?? fallbackSale?.mintStart ?? 0n,
        mintEnd: result<bigint>(4) ?? fallbackSale?.mintEnd ?? 0n,
        maxMints: result<bigint>(5) ?? fallbackSale?.maxMints ?? 0n,
        totalMinted: result<bigint>(6) ?? fallbackSale?.totalMinted ?? 0n,
        allowlistRoot: result<Hex>(7) ?? fallbackSale?.allowlistRoot ?? (ZERO_ROOT as Hex),
        walletCap: result<bigint>(8) ?? fallbackSale?.walletCap ?? 0n,
        referralShareBps: Number(result<number>(9) ?? fallbackSale?.referralShareBps ?? 0),
      }
    : null
  const livePrice = result<bigint>(0)
  const fallbackPrice = fallbackSale && initial.price !== null ? BigInt(initial.price) : null
  const priceWei = livePrice ?? fallbackPrice ?? sale?.price ?? 0n
  const priceAvailable = livePrice !== undefined || fallbackPrice !== null
  const mintedByRecipient = result<bigint>(10) ?? 0n

  const nowSec = useNowSec()
  const window = saleWindowOf(cfg, sale)
  const status = lifecycleStatus(window, minted, nowSec)
  const collectionRemaining = cfg.supplyCap > 0n ? cfg.supplyCap - minted : null
  const saleRemaining = sale?.maxMints && sale.maxMints > 0n
    ? sale.maxMints - sale.totalMinted
    : null
  const soldOut = (collectionRemaining !== null && collectionRemaining <= 0n)
    || (saleRemaining !== null && saleRemaining <= 0n)
  const gated = Boolean(sale && sale.allowlistRoot.toLowerCase() !== ZERO_ROOT)
  const walletCapped = Boolean(sale && sale.walletCap > 0n && mintedByRecipient >= sale.walletCap)
  const mintable = Boolean(
    sale
      && priceAvailable
      && !gated
      && !walletCapped
      && !soldOut
      && isMintable(window, minted, nowSec),
  )

  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: txHash, query: { retry: false } })

  useEffect(() => {
    if (receipt.isSuccess) {
      configRead.refetch()
      saleRead.refetch()
    }
  }, [receipt.isSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  const balanceQuery = useBalance({
    address: connected,
    query: { enabled: Boolean(connected), refetchInterval: 12_000 },
  })
  const balanceWei = balanceQuery.data?.value ?? 0n
  const insufficient = balanceQuery.isSuccess && priceWei > balanceWei

  const statusLabel = soldOut
    ? "Sold out"
    : walletCapped
      ? "Wallet limit reached"
      : gated
        ? "Allowlist mint"
        : status === SurfaceStatus.Scheduled
          ? "Not open yet"
          : status === SurfaceStatus.Closed
            ? "Closed"
            : priceAvailable
              ? "Open"
              : "Price unavailable"

  async function submit() {
    if (!connected || !minter || !mintable) return
    setLocalError(null)
    const refreshed = await saleRead.refetch()
    const quoted = refreshed.data?.[0]?.status === "success"
      ? refreshed.data[0].result as bigint
      : undefined
    if (quoted === undefined) {
      setLocalError("Could not confirm the current price. Try again.")
      return
    }
    if (quoted !== priceWei) {
      setPriceConfirmPending(true)
      return
    }
    setPriceConfirmPending(false)
    const request = prepareFixedPriceMint({
      chainId: 1,
      minter,
      recipient: connected,
      quantity: 1n,
      referrer: artistAddress,
      totalValue: quoted,
    })
    writeContract({
      address: request.target,
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
      value: request.value,
    })
  }

  if (!minter || !sale) {
    return <UnavailableNotice>This release has no supported primary minter configured.</UnavailableNotice>
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
      <div className="p-5 space-y-5">
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${mintable ? "bg-status-live animate-pulse" : "bg-gray-400"}`} />
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">{statusLabel}</span>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Minted</p>
            <p className="text-sm font-mono tabular-nums leading-none text-gray-500">
              {minted.toString()}{cfg.supplyCap > 0n ? ` / ${cfg.supplyCap.toString()}` : ""}
            </p>
          </div>
        </div>

        {priceAvailable ? <PriceRow priceWei={priceWei} /> : <UnavailableNotice>Current price unavailable.</UnavailableNotice>}

        {!isConnected ? (
          <RKConnectButton.Custom>
            {({ openConnectModal }) => (
              <button type="button" onClick={openConnectModal} className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-opacity">
                Connect wallet to mint
              </button>
            )}
          </RKConnectButton.Custom>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!mintable || isPending || receipt.isLoading || insufficient}
            className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-80 transition-opacity"
          >
            {receipt.isLoading
              ? "Waiting for confirmation…"
              : isPending
                ? "Confirm in wallet…"
                : insufficient
                  ? `Insufficient balance · ${trimEth(formatEther(balanceWei))} ETH available`
                  : mintable
                    ? "Mint"
                    : statusLabel}
          </button>
        )}

        {gated ? <UnavailableNotice>This self-hosted template does not yet have the artist&apos;s allowlist proof source, so it will not submit a doomed transaction.</UnavailableNotice> : null}
        {priceConfirmPending ? <UnavailableNotice>The price changed. Review the updated amount and click Mint again.</UnavailableNotice> : null}
        {localError ? <p className="text-[11px] font-mono text-status-sold" role="alert">{localError}</p> : null}
        {writeError ? <p className="text-[11px] font-mono text-status-sold" role="alert">{formatWriteError(writeError, "Mint")}</p> : null}
        {receipt.error ? <p className="text-[11px] font-mono text-status-sold" role="alert">{formatWriteError(receipt.error, "Mint")}</p> : null}
      </div>
    </div>
  )
}

function PriceRow({ priceWei }: { priceWei: bigint }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Price</p>
      <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
        {priceWei === 0n ? "Gas only" : <>{trimEth(formatEther(priceWei))} <span className="text-sm font-mono text-gray-500">ETH</span></>}
      </p>
    </div>
  )
}

function UnavailableNotice({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-mono leading-relaxed text-gray-500">{children}</p>
}

function trimEth(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value
}

function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}
