"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { formatEther, type Address } from "viem"
import { cleanEthAmountInput, parseEthAmount } from "@/lib/parseEthAmount"
import {
  useAccount,
  useChainId,
  useConfig,
  useSwitchChain,
} from "wagmi"
import { foundry, mainnet } from "wagmi/chains"
import {
  readContract,
  waitForTransactionReceipt,
  writeContract as writeContractAction,
} from "@wagmi/core"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import {
  erc721Abi,
  sovereignAuctionHouseAbi,
  sovereignAuctionHouseFactoryAbi,
} from "@pin/abi"
import {
  fetchSellerCancellableListings,
  resolveListingMetadata,
  type SellerListing,
  type SellerListingMeta,
} from "@/lib/seller-listings"
import { buildCancelCall } from "@/lib/platforms/cancel-calls"
import {
  migrationSavings,
  netReceived,
} from "@/lib/platforms/migration-savings"
import type { PlatformId } from "@/lib/platforms/types"
import { useArtistHouse } from "@/components/auction/useArtistHouse"
import { useThumbnailMedia } from "@/lib/use-thumbnail-media"

// Display names for the platform-section headers. New platforms slot in
// here when their adapter starts surfacing cancellable listings.
const PLATFORM_LABELS: Record<PlatformId, string> = {
  foundation: "Foundation",
  superrareV2: "SuperRare",
  transient: "Transient",
  manifold: "Manifold",
  mint: "Mint",
  sovereign: "Sovereign Auction House",
}

// In dev/fork mode (NEXT_PUBLIC_USE_LOCAL_RPC=1), the preferred
// wallet chain is the local Anvil chain (31337) — sending real txs
// to mainnet during a fork test would skip the fork entirely. In
// production this flag is unset and the wrong-network banner
// effectively never shows. `NEXT_PUBLIC_*` is statically inlined
// at build time, so the flag stays a boolean string — never an
// Alchemy URL — so nothing scrapeable lands in the bundle.
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const PREFERRED_CHAIN = FORK_MODE ? foundry : mainnet
const PREFERRED_CHAIN_LABEL = FORK_MODE ? "Foundry (local fork)" : "Ethereum"

// Stable display order for platform sections — Foundation first since
// that's the most common source today, SR second, others appended in
// PlatformId order.
const PLATFORM_ORDER: PlatformId[] = [
  "foundation",
  "superrareV2",
  "sovereign",
  "manifold",
]

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

function cancelLabelFor(platform: PlatformId): string {
  // Per-platform copy for the "Cancelling on …" status line so artists
  // know which marketplace is being touched (matters when migrating
  // multiple sources in one run).
  switch (platform) {
    case "foundation":
      return "Cancelling on FND…"
    case "superrareV2":
      return "Cancelling on SuperRare…"
    default:
      return "Cancelling…"
  }
}

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
          subtitle="Connect the artist wallet to load your active listings."
        />
        <ConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              onClick={openConnectModal}
              className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
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
  const chainId = useChainId()
  const { switchChain, isPending: switchPending } = useSwitchChain()
  const wrongNetwork = chainId !== PREFERRED_CHAIN.id

  const { factoryAddress, houseAddress, refetch: refetchHouse } =
    useArtistHouse(artistAddress)

  const [load, setLoad] = useState<LoadState>({ kind: "idle" })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rowState, setRowState] = useState<Map<string, RowState>>(new Map())
  const [running, setRunning] = useState(false)
  /** Non-null while per-token names/thumbnails are still streaming in. */
  const [metaProgress, setMetaProgress] = useState<{
    resolved: number
    total: number
  } | null>(null)
  // Bumped per refresh so a superseded run's late metadata can't write
  // into the next run's rows.
  const loadGenRef = useRef(0)

  /** Throttle for streaming meta into rows — one re-render per batch
   * instead of one per resolved token. */
  const META_FLUSH_MS = 250

  const refresh = useCallback(async () => {
    const gen = ++loadGenRef.current
    setLoad({ kind: "loading" })
    setMetaProgress(null)
    try {
      const { auctions, buyNows } =
        await fetchSellerCancellableListings(artistAddress)
      if (loadGenRef.current !== gen) return
      const all: SellerListing[] = [...auctions, ...buyNows]

      // Rows render immediately — reserve/duration prefill comes from
      // the listing itself. Names + thumbnails stream in behind them
      // (same treatment as the bulk-delist panel).
      const rows = all.map((source): Row => {
        const reserveWei =
          source.kind === "auction" ? source.reserveWei : source.priceWei
        const sourceDuration =
          source.kind === "auction" ? source.durationSeconds : 0
        return {
          id: source.id,
          source,
          meta: undefined,
          reserveInput: formatEther(reserveWei),
          durationSec: snapDuration(sourceDuration),
        }
      })
      setLoad({ kind: "loaded", rows })
      setSelected(new Set(rows.map((r) => r.id)))
      setRowState(new Map())
      if (all.length === 0) return
      setMetaProgress({ resolved: 0, total: all.length })

      const resolved = new Map<string, SellerListingMeta>()
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      const flush = (final: boolean) => {
        if (loadGenRef.current !== gen) return
        // Merge by spreading the existing row so in-flight user edits
        // (reserveInput, durationSec) survive the metadata arriving.
        setLoad((prev) =>
          prev.kind === "loaded"
            ? {
                ...prev,
                rows: prev.rows.map((r) =>
                  resolved.has(r.id) && !r.meta
                    ? { ...r, meta: resolved.get(r.id) }
                    : r,
                ),
              }
            : prev,
        )
        setMetaProgress(
          final ? null : { resolved: resolved.size, total: all.length },
        )
      }
      await resolveListingMetadata(all, {
        onItem: (id, meta) => {
          resolved.set(id, meta)
          if (flushTimer === null) {
            flushTimer = setTimeout(() => {
              flushTimer = null
              flush(false)
            }, META_FLUSH_MS)
          }
        },
      })
      if (flushTimer !== null) clearTimeout(flushTimer)
      flush(true)
    } catch (err) {
      if (loadGenRef.current !== gen) return
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load listings",
      })
      setMetaProgress(null)
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
      // 1. Cancel on the source marketplace. The platform discriminator
      //    on the listing routes us to the right contract+function via
      //    `buildCancelCall` — same code path for FND auctions, FND
      //    buy-nows, SR V2 auctions, and any future platform.
      updateRowState(row.id, { step: "cancelling" })
      const cancelCall = buildCancelCall(row.source)
      const cancelHash = await writeContractAction(config, {
        address: cancelCall.address,
        abi: cancelCall.abi,
        functionName: cancelCall.functionName,
        args: cancelCall.args,
        value: cancelCall.value,
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

      // Bust the seller-listings cache so a reload (or the next refetch)
      // doesn't return the row we just migrated. Without this, a 5-min
      // pgCache window keeps showing the stale listing, and re-clicking
      // re-attempts a cancel that reverts ("Must have an auction
      // configured" / "auctionId already cancelled"). Fire-and-forget —
      // the in-memory rowState is already "done" so the UI is consistent
      // even if this fails.
      void fetch(
        `/api/seller-listings/revalidate?seller=${artistAddress.toLowerCase()}`,
        { method: "POST" },
      ).catch(() => {})
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
          subtitle="Loading your active listings…"
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

  // Group rows by source platform so artists with listings on multiple
  // marketplaces see clear sections (Foundation, SuperRare, …) rather
  // than one unified-but-context-free list. Render order follows
  // PLATFORM_ORDER for stability.
  const rowsByPlatform = new Map<PlatformId, Row[]>()
  for (const platform of PLATFORM_ORDER) rowsByPlatform.set(platform, [])
  for (const row of load.rows) {
    const arr = rowsByPlatform.get(row.source.platform) ?? []
    arr.push(row)
    rowsByPlatform.set(row.source.platform, arr)
  }
  const platformSections = PLATFORM_ORDER.filter(
    (p) => (rowsByPlatform.get(p) ?? []).length > 0,
  )
  const showPlatformHeaders = platformSections.length > 1

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
              ? `${pendingRows.length} active ${pendingRows.length === 1 ? "listing" : "listings"} found across third-party marketplaces. Each row will be cancelled at its source and re-listed on your Sovereign auction house with the reserve and duration shown.`
              : `${pendingRows.length} active ${pendingRows.length === 1 ? "listing" : "listings"} found across third-party marketplaces. Your first migration will also deploy your Sovereign auction house (one extra signature, one-time only).`
        }
      />

      {wrongNetwork && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between gap-3">
          <p className="text-xs text-amber-900 leading-relaxed">
            Your wallet is on a different network. Switch to{" "}
            <span className="font-medium">{PREFERRED_CHAIN_LABEL}</span> to
            sign migration transactions.
            {FORK_MODE && (
              <>
                {" "}If your wallet has never seen this network, accept the
                prompt to add it (RPC <code>http://127.0.0.1:8545</code>,
                chain id <code>31337</code>).
              </>
            )}
          </p>
          <button
            onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
            disabled={switchPending}
            className="text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 bg-fg text-bg hover:opacity-80 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {switchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
          </button>
        </div>
      )}

      {metaProgress && (
        <div className="mb-4" aria-live="polite">
          <p className="text-[11px] font-mono text-gray-500 mb-1.5 tabular-nums">
            Loading artwork details… {metaProgress.resolved}/
            {metaProgress.total}
          </p>
          <div className="h-1 w-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-fg transition-[width] duration-300"
              style={{
                width: `${Math.round(
                  (metaProgress.resolved / metaProgress.total) * 100,
                )}%`,
              }}
            />
          </div>
        </div>
      )}

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
            className="text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running
              ? "Migrating…"
              : `Migrate ${selectedCount || ""} ${selectedCount === 1 ? "listing" : "listings"}`.replace(/\s+/g, " ").trim()}
          </button>
        </div>
      )}

      {platformSections.map((platform) => {
        const sectionRows = rowsByPlatform.get(platform) ?? []
        const list = (
          <ul className="divide-y divide-gray-100 border-y border-gray-100">
            {sectionRows.map((row) => (
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
        )
        if (!showPlatformHeaders) return <div key={platform}>{list}</div>
        return (
          <div key={platform} className="mb-4 last:mb-0">
            <p className="text-[11px] uppercase tracking-[0.08em] text-gray-400 mb-2">
              {PLATFORM_LABELS[platform]} · {sectionRows.length}
            </p>
            {list}
          </div>
        )
      })}

      {allDone ? (
        <div className="mt-5 flex items-center gap-3">
          <Link
            href={`/artist/${artistAddress}`}
            className="text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors"
          >
            Back to your artist page
          </Link>
        </div>
      ) : (
        <p className="mt-4 text-[11px] text-gray-400 leading-relaxed">
          Each migrated listing requires up to four signatures: cancel at the
          source marketplace, deploy your house (first time only), approve the
          collection (first time per collection), and create the new auction.
        </p>
      )}
    </Section>
  )
}

// ─── Row component ─────────────────────────────────────────────────────────

/**
 * 48px row thumbnail using the shared `useThumbnailMedia` escalation:
 * resolves `ipfs://` through the gateway cascade and renders works whose
 * media is a video (whole FND catalogs) as a muted <video> first-frame
 * still, instead of the broken-icon a plain <img> would show.
 */
function RowThumb({ url, alt }: { url: string; alt: string }) {
  const { kind, imgSrc, imgRef, onImgError, videoSrc, onVideoError } =
    useThumbnailMedia(url, 160)
  if (kind === "failed") return null
  if (kind === "video") {
    return (
      <video
        src={videoSrc}
        className="h-full w-full object-cover"
        muted
        playsInline
        preload="metadata"
        onError={onVideoError}
      />
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={imgSrc}
      alt={alt}
      className="h-full w-full object-cover"
      loading="lazy"
      onError={onImgError}
    />
  )
}

/**
 * Per-row migrate UI: a "this → that" comparison showing what the seller
 * receives at the source platform vs on their Sovereign house. The
 * destination's "you receive" line is in semibold (no color accent — the
 * numerical delta itself communicates the savings). Reserve / duration
 * are read-only by default; an Edit toggle slides the controls into view.
 */
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
  const [editing, setEditing] = useState(false)

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
  const editLocked = disabled || !!inFlight || state?.step === "done"

  const parsed = parseEthAmount(row.reserveInput)
  const reserveError = !parsed.ok ? parsed.reason : null
  const canMigrate = parsed.ok

  // Resolved fee-bps for the "you receive" math. Falls back to the
  // platform default for buy-nows (FND only — those charge 5%).
  const platformDefault =
    migrationSavings(row.source.platform, 0n)?.feeBps ?? 0
  const sourceFeeBps =
    row.source.kind === "auction"
      ? row.source.feeBps ?? platformDefault
      : platformDefault
  const sourcePlatformLabel =
    migrationSavings(row.source.platform, 0n)?.platformLabel ??
    row.source.platform

  return (
    <li className="py-4">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={checkboxDisabled}
          className="h-4 w-4 mt-3 shrink-0 accent-fg disabled:opacity-40"
          aria-label={`Select ${displayName}`}
        />
        <div className="h-12 w-12 mt-1 shrink-0 bg-gray-100 overflow-hidden rounded">
          {imageUrl && <RowThumb url={imageUrl} alt={displayName} />}
        </div>

        <div className="min-w-0 flex-1">
          {/* Title + primary action */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Link
                href={tokenHref}
                className="block text-sm font-medium text-gray-900 truncate hover:underline"
              >
                {displayName}
                {row.source.kind === "buyNow" && (
                  <span className="ml-2 text-[10px] font-normal text-amber-600">
                    buy-now → auction
                  </span>
                )}
              </Link>
              <p className="text-[11px] text-gray-400 tabular-nums truncate">
                {row.source.nftContract.slice(0, 6)}…
                {row.source.nftContract.slice(-4)} · #{row.source.tokenId}
              </p>
            </div>
            {state?.step === "done" || state?.step === "failed" || inFlight ? (
              <RowStatus state={state} platform={row.source.platform} />
            ) : (
              <button
                onClick={onMigrate}
                disabled={disabled || !canMigrate}
                className="text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 bg-fg text-bg hover:opacity-80 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Migrate →
              </button>
            )}
          </div>

          {state?.step === "done" ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 tabular-nums">
              <span>
                Listed at {row.reserveInput} ETH ·{" "}
                {durationLabel(row.durationSec)}
              </span>
              <Link
                href={tokenHref}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-gray-700 hover:text-fg hover:underline"
              >
                View auction →
              </Link>
              {state.txHash && (
                <a
                  href={`https://evm.now/tx/${state.txHash}?chainId=1`}
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
              {/* This → That comparison */}
              <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                <SideCard
                  label={sourcePlatformLabel}
                  reserveEth={row.reserveInput}
                  duration={durationLabel(row.durationSec)}
                  feeBps={sourceFeeBps}
                  emphasis="regular"
                />
                <span
                  className="text-gray-300 text-base leading-none select-none"
                  aria-hidden
                >
                  →
                </span>
                <SideCard
                  label="Your Sovereign auction house"
                  reserveEth={row.reserveInput}
                  duration={durationLabel(row.durationSec)}
                  feeBps={0}
                  emphasis="strong"
                />
              </div>

              {/* Edit toggle */}
              <div className="mt-2 flex items-center justify-end">
                <button
                  onClick={() => setEditing((v) => !v)}
                  disabled={editLocked}
                  className="text-[11px] font-medium text-gray-500 hover:text-fg underline disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-expanded={editing}
                >
                  {editing ? "Hide" : "Edit reserve / duration"}
                </button>
              </div>

              {/* Slide-out editor */}
              {editing && (
                <div className="mt-2 rounded-md bg-gray-50 p-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 items-center">
                  <span className="text-[10px] uppercase tracking-[0.08em] text-gray-500">
                    Reserve
                  </span>
                  <div className="flex items-stretch border border-gray-200 focus-within:border-gray-400 rounded bg-surface max-w-[200px]">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={row.reserveInput}
                      onChange={(e) =>
                        onChangeReserve(cleanEthAmountInput(e.target.value))
                      }
                      disabled={editLocked}
                      className="w-full px-3 py-1.5 text-sm outline-none bg-transparent tabular-nums disabled:opacity-40"
                    />
                    <span className="flex items-center px-2 text-[11px] text-gray-400 border-l border-gray-200">
                      ETH
                    </span>
                  </div>

                  <span className="text-[10px] uppercase tracking-[0.08em] text-gray-500">
                    Duration
                  </span>
                  <div className="flex gap-1">
                    {DURATION_OPTIONS.map((opt) => (
                      <button
                        key={opt.seconds}
                        onClick={() => onChangeDuration(opt.seconds)}
                        disabled={editLocked}
                        className={`px-2 py-1 text-xs border rounded transition-colors ${
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
              )}

              {reserveError && state?.step !== "failed" && (
                <p className="mt-2 text-xs text-red-500">{reserveError}</p>
              )}
              {state?.step === "failed" && state.error && (
                <p className="mt-2 text-xs text-red-500 break-words flex items-center justify-between gap-3">
                  <span>{state.error}</span>
                  <button
                    onClick={onMigrate}
                    disabled={disabled || !canMigrate}
                    className="text-xs font-medium px-3 py-1.5 border border-gray-300 hover:border-fg transition-colors rounded shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Retry
                  </button>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * Single side of the "this → that" comparison. Same internal layout on
 * both sides — reserve, duration, fee on top; "you receive" net amount
 * on the bottom. Visual differentiation is typographic only (semibold
 * on the destination's net) — no color accent, so the numerical delta
 * does the work.
 */
function SideCard({
  label,
  reserveEth,
  duration,
  feeBps,
  emphasis,
}: {
  label: string
  reserveEth: string
  duration: string
  feeBps: number
  emphasis: "regular" | "strong"
}) {
  const ethWeight = emphasis === "strong" ? "font-semibold" : "font-medium"
  const feePct = (feeBps / 100).toFixed(0) + "%"
  const net = netReceived(reserveEth, feeBps)

  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-gray-500 truncate">
        {label}
      </p>
      <p className="mt-1 text-[11px] text-gray-500 tabular-nums">
        {reserveEth} ETH reserve · {duration} · {feePct} fee
      </p>
      <div className="mt-2">
        <p className="text-[10px] uppercase tracking-[0.08em] text-gray-400">
          You receive
        </p>
        <p className={`mt-0.5 text-sm tabular-nums text-gray-900 ${ethWeight}`}>
          {net.eth} ETH
        </p>
        <p className="text-[11px] tabular-nums text-gray-500">{net.usd}</p>
      </div>
    </div>
  )
}

function RowStatus({
  state,
  platform,
}: {
  state: RowState | undefined
  platform: PlatformId
}) {
  if (!state || state.step === "idle") return null
  const base = "text-[11px] tabular-nums shrink-0"
  const link = state.txHash
    ? `https://evm.now/tx/${state.txHash}?chainId=1`
    : null
  const labels: Record<Step, string> = {
    idle: "",
    cancelling: cancelLabelFor(platform),
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

  // Per-platform "this auction was already cancelled / settled" reverts.
  // The user almost certainly already migrated this row in a prior click
  // and is seeing a stale-cache row. Translate into actionable copy
  // instead of leaking the contract's internal revert string.
  if (
    msg.includes("Must have an auction configured") || // SR Bazaar
    msg.includes("NFTMarketReserveAuction_Cannot_Cancel_Nonexistent_Auction") || // FND
    msg.includes("auction does not exist") ||
    msg.includes("Auction does not exist")
  ) {
    return "Already migrated — refresh to update the list"
  }
  return msg.split("\n")[0]
}
