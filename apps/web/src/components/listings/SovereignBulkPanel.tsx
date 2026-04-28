"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  createPublicClient,
  formatEther,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { writeContract as writeContractAction, waitForTransactionReceipt } from "wagmi/actions"
import { erc721Abi, sovereignAuctionHouseAbi } from "@pin/abi"
import { config as wagmiConfig } from "@/lib/wagmi"
import type { GalleryItem, GalleryPage } from "@/lib/artist-queries"
import { mapWithConcurrency } from "@/lib/concurrency"
import { resolveTokenMetadataDirect } from "@/lib/onchain-discovery"
import { ipfsToHttp } from "@pin/shared"
import { useArtistHouse } from "@/components/auction/useArtistHouse"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import { TxLink } from "@/components/auction/tx"

const DURATION_OPTIONS = [
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "3 days", seconds: 3 * 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const

const PAGE_SIZE = 100

const auctionCreatedEvent = parseAbiItem(
  "event AuctionCreated(uint256 indexed auctionId, uint256 indexed tokenId, address indexed tokenContract, uint256 duration, uint256 reservePrice, address tokenOwner)",
)

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ??
        "https://eth.llamarpc.com",
    ),
  })
}

type ListableItem = {
  contract: Address
  tokenId: string
  displayName: string
  imageUrl: string
}

type CancellableAuction = {
  auctionId: string
  contract: Address
  tokenId: string
  reserveWei: bigint
  displayName: string
  imageUrl: string | null
}

export function SovereignBulkPanel({ artistAddress }: { artistAddress: string }) {
  const { address: connectedAddress } = useAccount()
  const isOwner =
    !!connectedAddress &&
    connectedAddress.toLowerCase() === artistAddress.toLowerCase()

  const { houseAddress } = useArtistHouse(isOwner ? artistAddress : undefined)

  if (!isOwner || !houseAddress || !connectedAddress) return null

  return (
    <PanelInner
      artistAddress={artistAddress}
      connectedAddress={connectedAddress as Address}
      houseAddress={houseAddress as Address}
    />
  )
}

function PanelInner({
  artistAddress,
  connectedAddress,
  houseAddress,
}: {
  artistAddress: string
  connectedAddress: Address
  houseAddress: Address
}) {
  return (
    <div className="space-y-4">
      <BulkListSection
        artistAddress={artistAddress}
        connectedAddress={connectedAddress}
        houseAddress={houseAddress}
      />
      <BulkCancelSection
        connectedAddress={connectedAddress}
        houseAddress={houseAddress}
      />
    </div>
  )
}

// ─── Section 1: Bulk list ──────────────────────────────────────────────────

type ListLoadState =
  | { kind: "loading" }
  | { kind: "loaded"; items: ListableItem[] }
  | { kind: "error"; message: string }

function BulkListSection({
  artistAddress,
  connectedAddress,
  houseAddress,
}: {
  artistAddress: string
  connectedAddress: Address
  houseAddress: Address
}) {
  const router = useRouter()
  const [load, setLoad] = useState<ListLoadState>({ kind: "loading" })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const reserve = useEthAmountInput()
  const [durationSec, setDurationSec] = useState<number>(
    DURATION_OPTIONS[0].seconds,
  )

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" })
    try {
      const items = await loadListableItems(
        artistAddress,
        connectedAddress,
        houseAddress,
      )
      setLoad({ kind: "loaded", items })
      setSelected(new Set())
    } catch (err) {
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load tokens",
      })
    }
  }, [artistAddress, connectedAddress, houseAddress])

  useEffect(() => {
    refresh()
  }, [refresh])

  const groupedByContract = useMemo(() => {
    if (load.kind !== "loaded") return new Map<string, ListableItem[]>()
    const map = new Map<string, ListableItem[]>()
    for (const item of load.items) {
      const key = item.contract.toLowerCase()
      const arr = map.get(key) ?? []
      arr.push(item)
      map.set(key, arr)
    }
    return map
  }, [load])

  // Reserve = 0 is valid (no-reserve auction). The hook reports invalid for
  // empty/non-numeric/locale-mismatched input and surfaces the reason.
  const reserveValid = reserve.isValid && reserve.wei !== null

  // Listing tx state
  const [running, setRunning] = useState<{
    total: number
    current: number
    phase: "approve" | "create" | "idle"
  } | null>(null)
  const [batchError, setBatchError] = useState<string | null>(null)

  const itemKey = (item: ListableItem) =>
    `${item.contract.toLowerCase()}:${item.tokenId}`

  function toggle(item: ListableItem) {
    setSelected((prev) => {
      const next = new Set(prev)
      const k = itemKey(item)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  if (load.kind === "loading") {
    return (
      <Section>
        <p className="text-sm text-gray-500">Loading your tokens…</p>
      </Section>
    )
  }
  if (load.kind === "error") {
    return (
      <Section>
        <p className="text-sm text-red-500">{load.message}</p>
        <button
          onClick={refresh}
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-black"
        >
          Try again
        </button>
      </Section>
    )
  }

  if (load.items.length === 0) return null

  const total = load.items.length
  const allSelected = selected.size === total
  const isRunning = running !== null

  function toggleAll() {
    if (load.kind !== "loaded") return
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(load.items.map(itemKey)))
  }

  async function handleList() {
    if (load.kind !== "loaded") return
    if (!reserveValid || reserve.wei == null) return
    const selectedItems = load.items.filter((i) => selected.has(itemKey(i)))
    if (selectedItems.length === 0) return

    // Group by collection (bulkCreateAuctions takes one collection per call).
    const byContract = new Map<Address, ListableItem[]>()
    for (const item of selectedItems) {
      const key = (item.contract.toLowerCase() as Address) as Address
      const arr = byContract.get(key) ?? []
      arr.push(item)
      byContract.set(key, arr)
    }

    const groups = Array.from(byContract.entries())
    const reserveWei = reserve.wei

    setBatchError(null)
    setRunning({ total: groups.length, current: 0, phase: "create" })

    try {
      const client = getClient()

      let groupIndex = 0
      for (const [contract, items] of groups) {
        groupIndex += 1
        setRunning({
          total: groups.length,
          current: groupIndex,
          phase: "approve",
        })

        const isApproved = await client.readContract({
          address: contract,
          abi: erc721Abi,
          functionName: "isApprovedForAll",
          args: [connectedAddress, houseAddress],
        })

        if (!isApproved) {
          const approveHash = await writeContractAction(wagmiConfig, {
            address: contract,
            abi: erc721Abi,
            functionName: "setApprovalForAll",
            args: [houseAddress, true],
          })
          await waitForTransactionReceipt(wagmiConfig, { hash: approveHash })
        }

        setRunning({
          total: groups.length,
          current: groupIndex,
          phase: "create",
        })

        const tokenIds = items.map((i) => BigInt(i.tokenId))
        const createHash = await writeContractAction(wagmiConfig, {
          address: houseAddress,
          abi: sovereignAuctionHouseAbi,
          functionName: "bulkCreateAuctions",
          args: [contract, tokenIds, reserveWei, BigInt(durationSec)],
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: createHash })
      }

      setRunning(null)
      setSelected(new Set())
      router.refresh()
      await refresh()
    } catch (err) {
      setRunning(null)
      const msg = err instanceof Error ? err.message : "Listing failed"
      setBatchError(msg.includes("User rejected") ? "Transaction rejected" : msg.split("\n")[0])
    }
  }

  return (
    <Section>
      <header className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">List on auction house</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {total} {total === 1 ? "token" : "tokens"} available to list
          </p>
        </div>
        <button
          onClick={toggleAll}
          disabled={isRunning}
          className="text-xs font-medium text-gray-600 hover:text-black disabled:opacity-40"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </header>

      {Array.from(groupedByContract.entries()).map(([contract, items]) => (
        <Group key={contract} title={`Collection ${contract.slice(0, 6)}…${contract.slice(-4)}`}>
          {items.map((item) => (
            <TokenRow
              key={itemKey(item)}
              contract={item.contract}
              tokenId={item.tokenId}
              displayName={item.displayName}
              imageUrl={item.imageUrl}
              checked={selected.has(itemKey(item))}
              disabled={isRunning}
              onToggle={() => toggle(item)}
              right={null}
            />
          ))}
        </Group>
      ))}

      <div className="mt-5 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] uppercase tracking-[0.08em] text-gray-400">
            Reserve price
          </span>
          <div className="mt-1 flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors rounded">
            <input
              {...reserve.inputProps}
              placeholder="0.5"
              disabled={isRunning}
              className="flex-1 px-3 py-2 text-sm outline-none disabled:opacity-40 bg-transparent"
            />
            <span className="flex items-center px-3 text-xs text-gray-400 border-l border-gray-200">
              ETH
            </span>
          </div>
          {reserve.error && (
            <p className="mt-1 text-[11px] text-red-500">{reserve.error}</p>
          )}
        </label>
        <div className="block">
          <span className="text-[11px] uppercase tracking-[0.08em] text-gray-400">
            Duration
          </span>
          <div className="mt-1 grid grid-cols-3 gap-1.5">
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.seconds}
                onClick={() => setDurationSec(opt.seconds)}
                disabled={isRunning}
                className={`py-2 text-xs border rounded transition-colors ${
                  durationSec === opt.seconds
                    ? "border-black bg-black text-white"
                    : "border-gray-200 hover:border-gray-400"
                } disabled:opacity-40`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <footer className="mt-5 flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
        <p className="text-xs text-gray-500">
          {selected.size} selected
          {isRunning && running && (
            <span>
              {" "}— Step {running.current} of {running.total}{" "}
              ({running.phase === "approve" ? "approving collection" : "creating auctions"})
            </span>
          )}
        </p>
        <button
          onClick={handleList}
          disabled={isRunning || selected.size === 0 || !reserveValid}
          className="text-sm font-medium px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isRunning
            ? "Listing…"
            : `List ${selected.size || ""} ${selected.size === 1 ? "token" : "tokens"} for auction`.replace(/\s+/g, " ").trim()}
        </button>
      </footer>

      {batchError && (
        <p className="mt-2 text-xs text-red-500 break-words">{batchError}</p>
      )}
    </Section>
  )
}

// ─── Section 2: Bulk cancel pre-bid auctions ───────────────────────────────

type CancelLoadState =
  | { kind: "loading" }
  | { kind: "loaded"; auctions: CancellableAuction[] }
  | { kind: "error"; message: string }

function BulkCancelSection({
  connectedAddress,
  houseAddress,
}: {
  connectedAddress: Address
  houseAddress: Address
}) {
  const router = useRouter()
  const [load, setLoad] = useState<CancelLoadState>({ kind: "loading" })
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
    reset: resetWrite,
  } = useWriteContract()
  const {
    isLoading: isMining,
    isSuccess,
  } = useWaitForTransactionReceipt({ hash: txHash })

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" })
    try {
      const auctions = await loadCancellableAuctions(houseAddress)
      setLoad({ kind: "loaded", auctions })
      setSelected(new Set())
    } catch (err) {
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load auctions",
      })
    }
  }, [houseAddress])

  useEffect(() => {
    refresh()
  }, [refresh])

  // After cancel tx confirms: refresh + reset.
  useEffect(() => {
    if (!isSuccess) return
    router.refresh()
    refresh()
    resetWrite()
  }, [isSuccess, refresh, resetWrite, router])

  if (load.kind === "loading") {
    return (
      <Section>
        <p className="text-sm text-gray-500">Loading your house auctions…</p>
      </Section>
    )
  }
  if (load.kind === "error") {
    return (
      <Section>
        <p className="text-sm text-red-500">{load.message}</p>
        <button
          onClick={refresh}
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-black"
        >
          Try again
        </button>
      </Section>
    )
  }
  if (load.auctions.length === 0) return null

  const total = load.auctions.length
  const allSelected = selected.size === total
  const isRunning = isWritePending || isMining

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (load.kind !== "loaded") return
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(load.auctions.map((a) => a.auctionId)))
  }

  function handleCancel() {
    if (load.kind !== "loaded") return
    const ids = load.auctions
      .filter((a) => selected.has(a.auctionId))
      .map((a) => BigInt(a.auctionId))
    if (ids.length === 0) return
    writeContract({
      address: houseAddress,
      abi: sovereignAuctionHouseAbi,
      functionName: "bulkCancelAuctions",
      args: [ids],
    })
  }

  // Avoid unused-var warning while keeping connectedAddress reserved for future
  // permissioning checks (panel already gates upstream).
  void connectedAddress

  return (
    <Section>
      <header className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">
            Cancel pending auctions
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {total} pre-bid {total === 1 ? "auction" : "auctions"} on your house
          </p>
        </div>
        <button
          onClick={toggleAll}
          disabled={isRunning}
          className="text-xs font-medium text-gray-600 hover:text-black disabled:opacity-40"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </header>

      <Group title="Pre-bid (cancellable)">
        {load.auctions.map((a) => (
          <TokenRow
            key={a.auctionId}
            contract={a.contract}
            tokenId={a.tokenId}
            displayName={a.displayName}
            imageUrl={a.imageUrl}
            checked={selected.has(a.auctionId)}
            disabled={isRunning}
            onToggle={() => toggle(a.auctionId)}
            right={
              <p className="text-xs text-gray-400 tabular-nums shrink-0">
                Reserve {formatEther(a.reserveWei)} ETH
              </p>
            }
          />
        ))}
      </Group>

      <footer className="mt-5 flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
        <p className="text-xs text-gray-500">
          {selected.size} selected
          {isRunning && " — sign the cancel in your wallet"}
        </p>
        <button
          onClick={handleCancel}
          disabled={isRunning || selected.size === 0}
          className="text-sm font-medium px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isWritePending
            ? "Confirm in wallet…"
            : isMining
              ? "Cancelling…"
              : `Cancel ${selected.size || ""} ${selected.size === 1 ? "auction" : "auctions"}`.replace(/\s+/g, " ").trim()}
        </button>
      </footer>

      {txHash && isMining && <TxLink hash={txHash} label="Pending tx:" />}
      {writeError && (
        <p className="mt-2 text-xs text-red-500 break-words">
          {writeError.message.includes("User rejected")
            ? "Transaction rejected"
            : writeError.message.split("\n")[0]}
        </p>
      )}
    </Section>
  )
}

// ─── Data loaders ──────────────────────────────────────────────────────────

/**
 * Walk every page of the artist's gallery, then filter to tokens the connected
 * wallet still owns AND that don't already have an auction on the house. Single
 * multicall per check type would be cheaper but `mapWithConcurrency` keeps the
 * code simple and the parallelism bounded.
 */
async function loadListableItems(
  artistAddress: string,
  connectedAddress: Address,
  houseAddress: Address,
): Promise<ListableItem[]> {
  // Page through /api/artist/[address]/tokens (mirrors what ArtistGallery does).
  const all: GalleryItem[] = []
  let page = 0
  while (true) {
    const res = await fetch(
      `/api/artist/${artistAddress}/tokens?page=${page}&pageSize=${PAGE_SIZE}`,
    )
    if (!res.ok) throw new Error("Failed to load gallery")
    const payload = (await res.json()) as GalleryPage
    all.push(...payload.tokens)
    if (!payload.hasMore) break
    page += 1
    if (page > 50) break // safety cap; ~5000 tokens
  }

  if (all.length === 0) return []

  const client = getClient()

  // Per-token ownership + auction-existence check in parallel, capped.
  const results = await mapWithConcurrency(all, 8, async (item) => {
    const contract = item.contract as Address
    let owner: Address | null = null
    try {
      owner = (await client.readContract({
        address: contract,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [BigInt(item.tokenId)],
      })) as Address
    } catch {
      return null
    }
    if (!owner || owner.toLowerCase() !== connectedAddress.toLowerCase()) {
      return null
    }

    let hasAuction = false
    try {
      hasAuction = (await client.readContract({
        address: houseAddress,
        abi: sovereignAuctionHouseAbi,
        functionName: "hasAuctionFor",
        args: [contract, BigInt(item.tokenId)],
      })) as boolean
    } catch {
      hasAuction = false
    }
    if (hasAuction) return null

    return {
      contract,
      tokenId: item.tokenId,
      displayName: item.title,
      imageUrl: item.imageUrl,
    } satisfies ListableItem
  })

  return results.filter((r): r is ListableItem => r !== null)
}

/**
 * Enumerate every AuctionCreated event on the artist's house, then read the
 * current auction storage for each. Keep only those that:
 *   - are still in storage (`tokenOwner != 0`) — i.e. not settled or cancelled
 *   - have no bids (`firstBidTime == 0`) — the contract's only cancellable state
 */
async function loadCancellableAuctions(
  houseAddress: Address,
): Promise<CancellableAuction[]> {
  const client = getClient()

  const logs = await client.getLogs({
    address: houseAddress,
    event: auctionCreatedEvent,
    fromBlock: 0n,
    toBlock: "latest",
  })

  if (logs.length === 0) return []

  // Some auctions may have been recreated for the same auctionId — but the
  // contract uses a monotonic counter, so each id appears once. Still: dedupe
  // defensively.
  const seen = new Set<string>()
  const ids: bigint[] = []
  for (const log of logs) {
    const id = log.args.auctionId
    if (id === undefined) continue
    const key = id.toString()
    if (seen.has(key)) continue
    seen.add(key)
    ids.push(id)
  }

  // Parallel: read current auction state for each id.
  const states = await mapWithConcurrency(ids, 8, async (id) => {
    try {
      const result = (await client.readContract({
        address: houseAddress,
        abi: sovereignAuctionHouseAbi,
        functionName: "auctions",
        args: [id],
      })) as readonly [
        bigint, // tokenId
        Address, // tokenContract
        bigint, // firstBidTime
        bigint, // amount
        bigint, // reservePrice
        Address, // tokenOwner
        bigint, // endTime
        Address, // bidder
        bigint, // duration
      ]
      const [
        tokenId,
        tokenContract,
        firstBidTime,
        ,
        reservePrice,
        tokenOwner,
      ] = result
      // Filter: must still exist (tokenOwner != 0) AND be pre-bid.
      if (tokenOwner === "0x0000000000000000000000000000000000000000") return null
      if (firstBidTime !== 0n) return null
      return { id, tokenId, tokenContract, reservePrice }
    } catch {
      return null
    }
  })

  const cancellable = states.filter(
    (s): s is { id: bigint; tokenId: bigint; tokenContract: Address; reservePrice: bigint } =>
      s !== null,
  )

  // Resolve metadata in parallel via the same direct on-chain helper used elsewhere.
  const enriched = await mapWithConcurrency(cancellable, 8, async (s) => {
    let displayName = `#${s.tokenId.toString()}`
    let imageUrl: string | null = null
    try {
      const meta = await resolveTokenMetadataDirect(
        s.tokenContract,
        s.tokenId.toString(),
      )
      if (meta?.name) displayName = meta.name
      if (meta?.image) imageUrl = ipfsToHttp(meta.image)
    } catch {
      // fallthrough — fallback display
    }
    return {
      auctionId: s.id.toString(),
      contract: s.tokenContract,
      tokenId: s.tokenId.toString(),
      reserveWei: s.reservePrice,
      displayName,
      imageUrl,
    } satisfies CancellableAuction
  })

  return enriched
}

// ─── Shared UI primitives ──────────────────────────────────────────────────

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      {children}
    </div>
  )
}

function Group({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-4 last:mb-0">
      <p className="text-[11px] uppercase tracking-[0.08em] text-gray-400 mb-2">
        {title}
      </p>
      <ul className="divide-y divide-gray-100 border-y border-gray-100">
        {children}
      </ul>
    </div>
  )
}

function TokenRow({
  contract,
  tokenId,
  displayName,
  imageUrl,
  checked,
  disabled,
  onToggle,
  right,
}: {
  contract: string
  tokenId: string
  displayName: string
  imageUrl: string | null
  checked: boolean
  disabled: boolean
  onToggle: () => void
  right: React.ReactNode
}) {
  const tokenHref = `/${contract}/${tokenId}`
  return (
    <li className="flex items-center gap-3 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        className="h-4 w-4 shrink-0 accent-black disabled:opacity-40"
        aria-label={`Select ${displayName}`}
      />
      <div className="h-10 w-10 shrink-0 bg-gray-100 overflow-hidden">
        {imageUrl && (
          <Image
            src={imageUrl}
            alt=""
            width={40}
            height={40}
            className="h-full w-full object-cover"
            unoptimized
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <Link
          href={tokenHref}
          className="block text-sm font-medium text-gray-900 truncate hover:underline"
        >
          {displayName}
        </Link>
        <p className="text-xs text-gray-400 tabular-nums truncate">
          {contract.slice(0, 6)}…{contract.slice(-4)} · #{tokenId}
        </p>
      </div>
      {right}
    </li>
  )
}
