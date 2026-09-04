"use client"

import { useEffect, useMemo, useState } from "react"
import { formatEther, type Address } from "viem"
import {
  useAccount,
  useBalance,
  usePublicClient,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton as RKConnectButton } from "@rainbow-me/rainbowkit"
import { useReleaseState, useValidatedRelease } from "@pin/surface-react"
import {
  createDirectChainSurfaceProvider,
  formatWriteError,
  lifecycleStatus,
  releaseAvailability,
  SurfaceStatus,
  type IdMode,
  type ReleaseState,
  type ValidatedRelease,
} from "@pin/surface-kit"
import { type CollectionConfig, type MinterSaleConfig } from "@/lib/surface"

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
    owner: Address
    idMode: IdMode
    renderer: Address
    validatedAtBlock: string
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
  const initialSale = useMemo(
    () => initial.sale ? deserializeSale(initial.sale) : null,
    [initial.sale],
  )
  const initialRelease = useMemo<ValidatedRelease>(() => ({
    chainId: 1,
    collection: collectionAddress,
    protocol: "surface@1",
    owner: initial.owner,
    renderer: initial.renderer,
    idMode: initial.idMode,
    primaryMinter: initial.primaryMinter,
    validatedAtBlock: BigInt(initial.validatedAtBlock),
  }), [collectionAddress, initial.idMode, initial.owner, initial.primaryMinter, initial.renderer, initial.validatedAtBlock])
  const initialState = useMemo<ReleaseState | null>(() => {
    if (!initialSale) return null
    const cfg = deserializeCfg(initial.cfg)
    const minted = BigInt(initial.minted)
    return {
      release: initialRelease,
      account: recipient,
      minted,
      supplyCap: cfg.supplyCap,
      saleMinted: initialSale.totalMinted,
      saleSupplyCap: initialSale.maxMints,
      mintStart: initialSale.mintStart,
      mintEnd: initialSale.mintEnd,
      price: initial.price !== null ? BigInt(initial.price) : initialSale.price,
      priceStrategy: initialSale.priceStrategy,
      allowlistRoot: initialSale.allowlistRoot,
      walletCap: initialSale.walletCap,
      mintedByAccount: 0n,
      referralShareBps: initialSale.referralShareBps,
      lifecycle: lifecycleStatus({
        mintStart: initialSale.mintStart,
        mintEnd: initialSale.mintEnd,
        supplyCap: cfg.supplyCap,
      }, minted, Math.floor(Date.now() / 1000)),
      blockNumber: BigInt(initial.validatedAtBlock),
    }
  }, [initial.cfg, initial.minted, initial.price, initial.validatedAtBlock, initialRelease, initialSale, recipient])
  const publicClient = usePublicClient({ chainId: 1 })
  const provider = useMemo(
    () => publicClient ? createDirectChainSurfaceProvider({ client: publicClient }) : null,
    [publicClient],
  )
  const releaseRef = useMemo(
    () => ({ chainId: 1, collection: collectionAddress, protocol: "surface@1" as const }),
    [collectionAddress],
  )
  const validation = useValidatedRelease({
    provider,
    release: releaseRef,
    initialResult: { status: "available", value: initialRelease, evidence: { truth: "protocol", source: "server-first-paint", blockNumber: initial.validatedAtBlock } },
    refreshMs: 30_000,
  })
  const release = validation.value ?? initialRelease
  const liveState = useReleaseState({
    provider,
    release,
    account: recipient,
    initialResult: initialState
      ? { status: "available", value: initialState, evidence: { truth: "protocol", source: "server-first-paint", blockNumber: initial.validatedAtBlock } }
      : null,
    refreshMs: 12_000,
  })
  const state = liveState.value
  const initialCfg = deserializeCfg(initial.cfg)
  const cfg = state ? { ...initialCfg, supplyCap: state.supplyCap } : initialCfg
  const minted = state?.minted ?? BigInt(initial.minted)
  const minter = release.primaryMinter
  const stateMatchesRelease = Boolean(
    state
      && state.release.collection.toLowerCase() === release.collection.toLowerCase()
      && state.release.primaryMinter?.toLowerCase() === release.primaryMinter?.toLowerCase(),
  )
  const stateMatchesAccount = state?.account?.toLowerCase() === recipient.toLowerCase()
  const sale: MinterSaleConfig | null = state && minter && stateMatchesRelease
    ? {
        minter,
        price: state.price,
        priceStrategy: state.priceStrategy,
        mintStart: state.mintStart,
        mintEnd: state.mintEnd,
        maxMints: state.saleSupplyCap ?? 0n,
        totalMinted: state.saleMinted ?? 0n,
        allowlistRoot: state.allowlistRoot ?? ZERO_ROOT as `0x${string}`,
        walletCap: state.walletCap ?? 0n,
        referralShareBps: state.referralShareBps ?? 0,
      }
    : minter && initial.primaryMinter && minter.toLowerCase() === initial.primaryMinter.toLowerCase()
      ? initialSale
      : null
  const priceWei = state?.price ?? (initial.price !== null ? BigInt(initial.price) : sale?.price ?? 0n)
  const priceAvailable = state !== null || initial.price !== null
  const nowSec = useNowSec()
  const gated = Boolean(sale && sale.allowlistRoot.toLowerCase() !== ZERO_ROOT)
  const availability = state && stateMatchesRelease && stateMatchesAccount
    ? releaseAvailability(state, nowSec, { allowlistProofAvailable: !gated })
    : null
  const soldOut = availability?.soldOut ?? false
  const status = availability?.lifecycle ?? SurfaceStatus.Closed
  const walletCapped = availability?.walletCapped ?? false
  const mintable = Boolean(
    sale
      && priceAvailable
      && validation.phase !== "blocked"
      && liveState.phase !== "blocked"
      && stateMatchesRelease
      && stateMatchesAccount
      && availability?.mintable,
  )

  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: txHash, query: { retry: false } })

  useEffect(() => {
    if (receipt.isSuccess) {
      void validation.refresh()
      void liveState.refresh()
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
    if (!connected || !minter || !mintable || !provider) return
    setLocalError(null)
    const quoteResult = await provider.quoteMint({
      release,
      account: connected,
      quantity: 1n,
      referrer: artistAddress,
    })
    if (quoteResult.status !== "available" && quoteResult.status !== "partial") {
      setLocalError("Could not confirm the current price. Try again.")
      return
    }
    const quoted = quoteResult.value.totalValue
    if (quoted !== priceWei) {
      setPriceConfirmPending(true)
      await liveState.refresh()
      return
    }
    setPriceConfirmPending(false)
    const prepared = await provider.prepareMint({
      release,
      account: connected,
      quantity: 1n,
      referrer: artistAddress,
      quote: quoteResult.value,
    })
    if (prepared.status !== "available" && prepared.status !== "partial") {
      setLocalError(prepared.reason)
      return
    }
    const request = prepared.value
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
