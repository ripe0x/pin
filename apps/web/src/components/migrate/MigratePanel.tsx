"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { formatEther, type Address } from "viem"
import { cleanEthAmountInput, parseEthAmount } from "@/lib/parseEthAmount"
import {
  useAccount,
  useConfig,
} from "wagmi"
import {
  readContract,
  waitForTransactionReceipt,
  writeContract as writeContractAction,
} from "@wagmi/core"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import {
  erc721Abi,
  nftMarketAbi,
  sovereignAuctionHouseAbi,
  sovereignAuctionHouseFactoryAbi,
} from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import {
  fetchSellerCancellableListings,
  resolveListingMetadata,
  type AuctionListing,
  type BuyNowListing,
  type SellerListing,
  type SellerListingMeta,
} from "@/lib/seller-listings"
import { useArtistHouse } from "@/components/auction/useArtistHouse"

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]

const DURATION_OPTIONS = [
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "3 days", seconds: 3 * 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const

type DurationSec = (typeof DURATION_OPTIONS)[number]["seconds"]

/**
 * Snap an arbitrary duration (seconds) to the nearest of the three Sovereign
 * options. Foundation auctions can have any duration, but the Sovereign UI
 * exposes a fixed enum — pick the closest so the artist's intent survives.
 * Buy-nows have no duration; callers pass 0 and we default to 24 h.
 */
function snapDuration(seconds: number): DurationSec {
  if (seconds <= 0) return DURATION_OPTIONS[0].seconds
  let best: DurationSec = DURATION_OPTIONS[0].seconds
  let bestDiff = Math.abs(seconds - best)
  for (const opt of DURATION_OPTIONS) {
    const diff = Math.abs(seconds - opt.seconds)
    if (diff < bestDiff) {
      bestDiff = diff
      best = opt.seconds
    }
  }
  return best
}

type Step =
  | "idle"
  | "cancelling"
  | "deploying"
  | "approving"
  | "listing"
  | "done"
  | "failed"

type RowState = {
  step: Step
  txHash?: `0x${string}`
  error?: string
}

type Row = {
  id: string
  source: SellerListing
  meta: SellerListingMeta | undefined
  // Editable fields, prefilled from Foundation listing.
  reserveInput: string
  durationSec: DurationSec
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; rows: Row[] }
  | { kind: "error"; message: string }

export function MigratePanel({ artistAddress }: { artistAddress: string }) {
  const { address: connected, isConnected } = useAccount()
  const isArtist =
    !!connected && connected.toLowerCase() === artistAddress.toLowerCase()

  if (!isConnected) {
    return (
      <Section>
        <Heading
          title="Migrate to your Sovereign auction house"
          subtitle="Connect the artist wallet to load your Foundation listings."
        />
        <ConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              onClick={openConnectModal}
              className="block w-full text-center text-sm font-medium py-3 bg-fg text-bg hover:opacity-80 transition-colors"
            >
              Connect wallet
            </button>
          )}
        </ConnectButton.Custom>
      </Section>
    )
  }

  if (!isArtist) {
    return (
      <Section>
        <Heading
          title="Migrate to your Sovereign auction house"
          subtitle={`This page can only be used by ${shortAddr(artistAddress)}. You are connected as ${shortAddr(connected!)}.`}
        />
        <Link
          href={`/artist/${artistAddress}`}
          className="text-xs font-medium underline text-gray-700 hover:text-fg"
        >
          Back to artist page
        </Link>
      </Section>
    )
  }

  return <Inner artistAddress={artistAddress} connected={connected as Address} />
}

function Inner({
  artistAddress,
  connected,
}: {
  artistAddress: string
  connected: Address
}) {
  const config = useConfig()
  const { factoryAddress, houseAddress, refetch: refetchHouse } =
    useArtistHouse(artistAddress)

  const [load, setLoad] = useState<LoadState>({ kind: "idle" })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rowState, setRowState] = useState<Map<string, RowState>>(new Map())
  const [running, setRunning] = useState(false)

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" })
    try {
      const { auctions, buyNows } =
        await fetchSellerCancellableListings(artistAddress)
      const all: SellerListing[] = [...auctions, ...buyNows]
      const meta = await resolveListingMetadata(all)
      const rows = all.map((source): Row => {
        const reserveWei =
          source.kind === "auction" ? source.reserveWei : source.priceWei
        const sourceDuration =
          source.kind === "auction" ? source.durationSeconds : 0
        return {
          id: source.id,
          source,
          meta: meta.get(source.id),
          reserveInput: formatEther(reserveWei),
          durationSec: snapDuration(sourceDuration),
        }
      })
      setLoad({ kind: "loaded", rows })
      setSelected(new Set(rows.map((r) => r.id)))
      setRowState(new Map())
    } catch (err) {
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load listings",
      })
    }
  }, [artistAddress])

  useEffect(() => {
    refresh()
  }, [refresh])

  const updateRowState = useCallback((id: string, next: RowState) => {
    setRowState((prev) => {
      const m = new Map(prev)
      m.set(id, next)
      return m
    })
  }, [])

  const setRowField = useCallback(
    (id: string, patch: Partial<Pick<Row, "reserveInput" | "durationSec">>) => {
      setLoad((prev) => {
        if (prev.kind !== "loaded") return prev
        return {
          ...prev,
          rows: prev.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        }
      })
    },
    [],
  )

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function parseRowReserve(row: Row) {
    return parseEthAmount(row.reserveInput)
  }

  async function ensureHouse(): Promise<Address | null> {
    if (houseAddress) return houseAddress
    if (!factoryAddress) {
      throw new Error("Factory not deployed on this network")
    }
    const txHash = await writeContractAction(config, {
      address: factoryAddress,
      abi: sovereignAuctionHouseFactoryAbi,
      functionName: "createAuctionHouse",
      args: [],
    })
    await waitForTransactionReceipt(config, { hash: txHash })
    const result = await refetchHouse()
    const newAddress = (result.data ?? null) as Address | null
    if (
      !newAddress ||
      newAddress === "0x0000000000000000000000000000000000000000"
    ) {
      throw new Error("House deploy succeeded but address could not be read")
    }
    return newAddress
  }

  async function ensureApproved(
    contract: Address,
    house: Address,
  ): Promise<void> {
    const approved = (await readContract(config, {
      address: contract,
      abi: erc721Abi,
      functionName: "isApprovedForAll",
      args: [connected, house],
    })) as boolean
    if (approved) return
    const txHash = await writeContractAction(config, {
      address: contract,
      abi: erc721Abi,
      functionName: "setApprovalForAll",
      args: [house, true],
    })
    await waitForTransactionReceipt(config, { hash: txHash })
  }

  async function migrateOne(row: Row): Promise<void> {
    const parsed = parseRowReserve(row)
    if (!parsed.ok) {
      updateRowState(row.id, { step: "failed", error: parsed.reason })
      return
    }
    const reserveWei = parsed.wei
    try {
      // 1. Cancel on Foundation.
      updateRowState(row.id, { step: "cancelling" })
      const cancelHash =
        row.source.kind === "auction"
          ? await writeContractAction(config, {
              address: MARKET_ADDRESS,
              abi: nftMarketAbi,
              functionName: "cancelReserveAuction",
              args: [(row.source as AuctionListing).auctionId],
            })
          : await writeContractAction(config, {
              address: MARKET_ADDRESS,
              abi: nftMarketAbi,
              functionName: "cancelBuyPrice",
              args: [
                (row.source as BuyNowListing).nftContract,
                BigInt((row.source as BuyNowListing).tokenId),
              ],
            })
      updateRowState(row.id, { step: "cancelling", txHash: cancelHash })
      await waitForTransactionReceipt(config, { hash: cancelHash })

      // 2. Deploy house if missing.
      updateRowState(row.id, { step: "deploying" })
      const house = await ensureHouse()
      if (!house) throw new Error("No Sovereign house available")

      // 3. Approve collection if needed.
      updateRowState(row.id, { step: "approving" })
      await ensureApproved(row.source.nftContract, house)

      // 4. Create auction on Sovereign.
      updateRowState(row.id, { step: "listing" })
      const tokenIds = [BigInt(row.source.tokenId)]
      const createHash = await writeContractAction(config, {
        address: house,
        abi: sovereignAuctionHouseAbi,
        functionName: "bulkCreateAuctions",
        args: [
          row.source.nftContract,
          tokenIds,
          reserveWei,
          BigInt(row.durationSec),
        ],
      })
      updateRowState(row.id, { step: "listing", txHash: createHash })
      await waitForTransactionReceipt(config, { hash: createHash })

      updateRowState(row.id, { step: "done", txHash: createHash })
    } catch (err) {
      updateRowState(row.id, {
        step: "failed",
        error: friendlyError(err),
      })
    }
  }

  async function handleMigrateOne(row: Row) {
    if (running) return
    setRunning(true)
    try {
      await migrateOne(row)
    } finally {
      setRunning(false)
    }
  }

  async function handleMigrateSelected() {
    if (running) return
    if (load.kind !== "loaded") return
    const selectedRows = load.rows.filter((r) => selected.has(r.id))
    if (selectedRows.length === 0) return
    setRunning(true)
    try {
      for (const row of selectedRows) {
        const cur = rowState.get(row.id)
        if (cur?.step === "done") continue
        await migrateOne(row)
      }
    } finally {
      setRunning(false)
    }
  }

  if (load.kind === "idle" || load.kind === "loading") {
    return (
      <Section>
        <Heading
          title="Migrate to your Sovereign auction house"
          subtitle="Loading your Foundation listings…"
        />
      </Section>
    )
  }

  if (load.kind === "error") {
    return (
      <Section>
        <Heading
          title="Migrate to your Sovereign auction house"
          subtitle={load.message}
        />
        <button
          onClick={refresh}
          className="text-xs font-medium underline text-gray-700 hover:text-fg"
        >
          Try again
        </button>
      </Section>
    )
  }

  const pendingRows = load.rows.filter(
    (r) => rowState.get(r.id)?.step !== "done",
  )
  const doneCount = load.rows.length - pendingRows.length
  const allDone = load.rows.length > 0 && pendingRows.length === 0

  const allSelected =
    pendingRows.length > 0 &&
    pendingRows.every((r) => selected.has(r.id))
  const selectedCount = pendingRows.filter((r) => selected.has(r.id)).length

  function toggleAll() {
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev)
        for (const r of pendingRows) next.delete(r.id)
        return next
      })
    } else {
      setSelected((prev) => {
        const next = new Set(prev)
        for (const r of pendingRows) next.add(r.id)
        return next
      })
    }
  }

  return (
    <Section>
      <Heading
        title={
          allDone
            ? "Migration complete"
            : "Migrate to your Sovereign auction house"
        }
        subtitle={
          allDone
            ? `All ${doneCount} ${doneCount === 1 ? "listing" : "listings"} are now live on your Sovereign auction house.`
            : houseAddress
              ? `${pendingRows.length} ${pendingRows.length === 1 ? "listing" : "listings"} on the Foundation contract. Each row will be cancelled and re-listed on your Sovereign auction house with the reserve and duration shown.`
              : `${pendingRows.length} ${pendingRows.length === 1 ? "listing" : "listings"} on the Foundation contract. Your first migration will also deploy your Sovereign auction house (one extra signature, one-time only).`
        }
      />

      {!allDone && (
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={toggleAll}
            disabled={running}
            className="text-xs font-medium text-gray-600 hover:text-fg disabled:opacity-40"
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
          <button
            onClick={handleMigrateSelected}
            disabled={running || selectedCount === 0}
            className="text-sm font-medium px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running
              ? "Migrating…"
              : `Migrate ${selectedCount || ""} ${selectedCount === 1 ? "listing" : "listings"}`.replace(/\s+/g, " ").trim()}
          </button>
        </div>
      )}

      <ul className="divide-y divide-gray-100 border-y border-gray-100">
        {load.rows.map((row) => (
          <MigrateRow
            key={row.id}
            row={row}
            checked={selected.has(row.id)}
            onToggle={() => toggle(row.id)}
            onChangeReserve={(v) => setRowField(row.id, { reserveInput: v })}
            onChangeDuration={(s) =>
              setRowField(row.id, { durationSec: s as DurationSec })
            }
            state={rowState.get(row.id)}
            disabled={running}
            onMigrate={() => handleMigrateOne(row)}
          />
        ))}
      </ul>

      {allDone ? (
        <div className="mt-5 flex items-center gap-3">
          <Link
            href={`/artist/${artistAddress}`}
            className="text-sm font-medium px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors"
          >
            Back to your artist page
          </Link>
        </div>
      ) : (
        <p className="mt-4 text-[11px] text-gray-400 leading-relaxed">
          Each migrated listing requires up to four signatures: cancel on
          Foundation, deploy your house (first time only), approve the
          collection (first time per collection), and create the new auction.
        </p>
      )}
    </Section>
  )
}

// ─── Row component ─────────────────────────────────────────────────────────

function MigrateRow({
  row,
  checked,
  onToggle,
  onChangeReserve,
  onChangeDuration,
  state,
  disabled,
  onMigrate,
}: {
  row: Row
  checked: boolean
  onToggle: () => void
  onChangeReserve: (v: string) => void
  onChangeDuration: (s: number) => void
  state: RowState | undefined
  disabled: boolean
  onMigrate: () => void
}) {
  const meta = row.meta
  const displayName = meta?.displayName ?? `#${row.source.tokenId}`
  const imageUrl = meta?.imageUrl
  const tokenHref = `/${row.source.nftContract}/${row.source.tokenId}`

  const inFlight =
    state &&
    state.step !== "idle" &&
    state.step !== "done" &&
    state.step !== "failed"

  const checkboxDisabled = disabled || !!inFlight || state?.step === "done"

  // Validate the reserve string locally so the user gets immediate feedback
  // (decimal-comma support, bad characters, etc.) before clicking Delist.
  const parsed = parseEthAmount(row.reserveInput)
  const reserveError = !parsed.ok ? parsed.reason : null
  const canMigrate = parsed.ok

  return (
    <li className="py-4">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={checkboxDisabled}
          className="h-4 w-4 mt-3 shrink-0 accent-black disabled:opacity-40"
          aria-label={`Select ${displayName}`}
        />
        <div className="h-12 w-12 mt-1 shrink-0 bg-gray-100 overflow-hidden">
          {imageUrl && (
            <Image
              src={imageUrl}
              alt=""
              width={48}
              height={48}
              className="h-full w-full object-cover"
              unoptimized
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Link
                href={tokenHref}
                className="block text-sm font-medium text-gray-900 truncate hover:underline"
              >
                {displayName}
              </Link>
              <p className="text-[11px] text-gray-400 tabular-nums truncate">
                {row.source.nftContract.slice(0, 6)}…
                {row.source.nftContract.slice(-4)} · #{row.source.tokenId}
                {row.source.kind === "buyNow" && (
                  <span className="ml-2 text-amber-600">
                    buy-now → auction
                  </span>
                )}
              </p>
            </div>
            <RowStatus state={state} />
          </div>

          {state?.step === "done" ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 tabular-nums">
              <span>
                Listed at {row.reserveInput} ETH · {durationLabel(row.durationSec)}
              </span>
              <Link
                href={tokenHref}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-emerald-700 hover:underline"
              >
                View auction →
              </Link>
              {state.txHash && (
                <a
                  href={`https://etherscan.io/tx/${state.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-gray-600 hover:underline"
                >
                  View tx ↗
                </a>
              )}
            </div>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="text-[11px] uppercase tracking-[0.08em] text-gray-400">
                    Reserve
                  </span>
                  <div className="mt-1 flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors rounded">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={row.reserveInput}
                      onChange={(e) => onChangeReserve(cleanEthAmountInput(e.target.value))}
                      disabled={disabled || !!inFlight}
                      className="w-24 px-3 py-1.5 text-sm outline-none disabled:opacity-40 bg-transparent tabular-nums"
                    />
                    <span className="flex items-center px-2 text-[11px] text-gray-400 border-l border-gray-200">
                      ETH
                    </span>
                  </div>
                </label>
                <div className="block">
                  <span className="text-[11px] uppercase tracking-[0.08em] text-gray-400">
                    Duration
                  </span>
                  <div className="mt-1 flex gap-1">
                    {DURATION_OPTIONS.map((opt) => (
                      <button
                        key={opt.seconds}
                        onClick={() => onChangeDuration(opt.seconds)}
                        disabled={disabled || !!inFlight}
                        className={`px-2 py-1.5 text-xs border rounded transition-colors ${
                          row.durationSec === opt.seconds
                            ? "border-fg bg-fg text-bg"
                            : "border-gray-200 hover:border-gray-400"
                        } disabled:opacity-40`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={onMigrate}
                  disabled={disabled || !!inFlight || !canMigrate}
                  className="text-xs font-medium px-3 py-1.5 border border-gray-300 hover:border-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
                >
                  {state?.step === "failed" ? "Retry" : "Delist & relist"}
                </button>
              </div>

              {reserveError && state?.step !== "failed" && (
                <p className="mt-2 text-xs text-red-500">{reserveError}</p>
              )}
              {state?.step === "failed" && state.error && (
                <p className="mt-2 text-xs text-red-500 break-words">
                  {state.error}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  )
}

function RowStatus({ state }: { state: RowState | undefined }) {
  if (!state || state.step === "idle") return null
  const base = "text-[11px] tabular-nums shrink-0"
  const link = state.txHash
    ? `https://etherscan.io/tx/${state.txHash}`
    : null
  const labels: Record<Step, string> = {
    idle: "",
    cancelling: "Cancelling on FND…",
    deploying: "Deploying house…",
    approving: "Approving collection…",
    listing: "Listing on Sovereign…",
    done: "Migrated ✓",
    failed: "Failed",
  }
  const cls =
    state.step === "done"
      ? "text-emerald-600"
      : state.step === "failed"
        ? "text-red-500"
        : "text-amber-600"
  const text = labels[state.step]
  if (link) {
    return (
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className={`${base} ${cls} hover:underline`}
      >
        {text}
      </a>
    )
  }
  return <span className={`${base} ${cls}`}>{text}</span>
}

// ─── Layout primitives ─────────────────────────────────────────────────────

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5">
      {children}
    </div>
  )
}

function Heading({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}) {
  return (
    <header className="mb-4">
      <h1 className="text-lg font-semibold tracking-tight text-gray-900">
        {title}
      </h1>
      {subtitle && (
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">{subtitle}</p>
      )}
    </header>
  )
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function durationLabel(seconds: number): string {
  const opt = DURATION_OPTIONS.find((o) => o.seconds === seconds)
  return opt?.label ?? `${seconds}s`
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (
    msg.includes("User rejected") ||
    msg.includes("User denied") ||
    msg.includes("UserRejected")
  ) {
    return "Transaction rejected"
  }
  if (msg.includes("insufficient funds")) return "Insufficient ETH balance"
  return msg.split("\n")[0]
}
