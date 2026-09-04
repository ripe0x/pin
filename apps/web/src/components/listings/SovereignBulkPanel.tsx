"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  http,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { writeContract as writeContractAction, waitForTransactionReceipt } from "wagmi/actions"
import { erc721Abi, sovereignAuctionHouseAbi, sovereignAuctionHouseV2Abi } from "@pin/abi"
import { config as wagmiConfig } from "@/lib/wagmi"
import type { GalleryItem, GalleryPage } from "@/lib/artist-queries"
import { mapWithConcurrency } from "@/lib/concurrency"
import { ipfsToHttp } from "@pin/shared"
import { useArtistHouse } from "@/components/auction/useArtistHouse"
import { useArtistHouseV2 } from "@/components/auction/useArtistHouseV2"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import { useChainNowSec } from "@/components/tx/tx-ui"
import { parseListingExpiry } from "@/lib/listing-expiry"
import { TxLink, StatusChip } from "@/components/auction/tx"
import { useBatchedCalls, type PreparedCall } from "@/lib/useBatchedCalls"

const DURATION_OPTIONS = [
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "3 days", seconds: 3 * 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const

const PAGE_SIZE = 100

function getClient() {
  // Use the server-side `/api/rpc` proxy to avoid bundling the Alchemy API
  // key into this client component.
  return createPublicClient({
    chain: mainnet,
    transport: http("/api/rpc"),
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

  const v1 = useArtistHouse(isOwner ? artistAddress : undefined)
  const v2 = useArtistHouseV2(isOwner ? artistAddress : undefined)

  if (!isOwner || !connectedAddress) return null
  if (!v1.houseAddress && !v2.houseAddress) return null

  return (
    <PanelInner
      artistAddress={artistAddress}
      connectedAddress={connectedAddress as Address}
      // Bulk listing targets the newest house generation (V2 when live).
      listHouseAddress={(v2.houseAddress ?? v1.houseAddress) as Address}
      listHouseVersion={v2.houseAddress ? 2 : 1}
      // Bulk cancel runs per house generation the artist actually has: V1
      // via bulkCancelAuctions (one tx), V2 via N cancelAuction calls (V2
      // dropped bulkCancelAuctions) through the batched-calls runner.
      v1HouseAddress={v1.houseAddress}
      v2HouseAddress={v2.houseAddress}
    />
  )
}

function PanelInner({
  artistAddress,
  connectedAddress,
  listHouseAddress,
  listHouseVersion,
  v1HouseAddress,
  v2HouseAddress,
}: {
  artistAddress: string
  connectedAddress: Address
  listHouseAddress: Address
  listHouseVersion: 1 | 2
  v1HouseAddress: Address | null
  v2HouseAddress: Address | null
}) {
  return (
    <div className="space-y-4">
      <BulkListSection
        artistAddress={artistAddress}
        connectedAddress={connectedAddress}
        houseAddress={listHouseAddress}
        houseVersion={listHouseVersion}
      />
      {v1HouseAddress && (
        <BulkCancelSection
          connectedAddress={connectedAddress}
          houseAddress={v1HouseAddress}
          houseVersion={1}
        />
      )}
      {v2HouseAddress && (
        <BulkCancelSection
          connectedAddress={connectedAddress}
          houseAddress={v2HouseAddress}
          houseVersion={2}
        />
      )}
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
  houseVersion,
}: {
  artistAddress: string
  connectedAddress: Address
  houseAddress: Address
  houseVersion: 1 | 2
}) {
  const router = useRouter()
  const [load, setLoad] = useState<ListLoadState>({ kind: "loading" })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const reserve = useEthAmountInput()
  const [durationSec, setDurationSec] = useState<number>(
    DURATION_OPTIONS[0].seconds,
  )
  // V2-only: one listing expiry applies to the whole batch. Funds recipient
  // has no bulk-create parameter (it's per-auction, set only via
  // setAuctionFundsRecipient), omitted here rather than following up with
  // N setter calls; edit it per auction from its detail page afterward.
  const nowSec = useChainNowSec()
  const [listingExpiryInput, setListingExpiryInput] = useState("")
  const listingExpiry = parseListingExpiry(listingExpiryInput, nowSec)

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" })
    try {
      const items = await loadListableItems(
        artistAddress,
        connectedAddress,
        houseAddress,
        houseVersion,
      )
      setLoad({ kind: "loaded", items })
      setSelected(new Set())
    } catch (err) {
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load tokens",
      })
    }
  }, [artistAddress, connectedAddress, houseAddress, houseVersion])

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
  const listingTermsValid = houseVersion !== 2 || listingExpiry.error === null

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
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-fg"
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
    if (!reserveValid || reserve.wei == null || !listingTermsValid) return
    const selectedItems = load.items.filter((i) => selected.has(itemKey(i)))
    if (selectedItems.length === 0) return
    const listingExpirySeconds =
      houseVersion === 2 ? listingExpiry.seconds ?? 0n : 0n

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

      // Collapse the per-contract `isApprovedForAll` reads into a single
      // multicall. Was N sequential RPC reads inside the loop; now one
      // batched call before the loop starts. Lookup map keyed by lowercase
      // contract.
      const contractAddresses = groups.map(([c]) => c)
      const approvalResults = await client.multicall({
        contracts: contractAddresses.map((c) => ({
          address: c,
          abi: erc721Abi,
          functionName: "isApprovedForAll" as const,
          args: [connectedAddress, houseAddress] as const,
        })),
        allowFailure: true,
      })
      const approvalByContract = new Map<string, boolean>()
      contractAddresses.forEach((c, i) => {
        const r = approvalResults[i]
        // Treat failures conservatively as "not approved" — the user will
        // be prompted to approve and the next attempt will succeed.
        approvalByContract.set(
          c.toLowerCase(),
          r.status === "success" ? Boolean(r.result) : false,
        )
      })

      let groupIndex = 0
      for (const [contract, items] of groups) {
        groupIndex += 1
        setRunning({
          total: groups.length,
          current: groupIndex,
          phase: "approve",
        })

        const isApproved = approvalByContract.get(contract.toLowerCase()) ?? false

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
        const createHash =
          houseVersion === 2
            ? await writeContractAction(wagmiConfig, {
                address: houseAddress,
                abi: sovereignAuctionHouseV2Abi,
                functionName: "bulkCreateAuctions",
                args: [contract, tokenIds, reserveWei, BigInt(durationSec), listingExpirySeconds],
              })
            : await writeContractAction(wagmiConfig, {
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
          className="text-xs font-medium text-gray-600 hover:text-fg disabled:opacity-40"
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
                    ? "border-fg bg-fg text-bg"
                    : "border-gray-200 hover:border-gray-400"
                } disabled:opacity-40`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {houseVersion === 2 && (
        <div className="mt-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.08em] text-gray-400">
              Listing expiry (optional)
            </span>
            <input
              type="datetime-local"
              value={listingExpiryInput}
              onChange={(e) => setListingExpiryInput(e.target.value)}
              disabled={isRunning}
              className="mt-1 w-full border border-gray-200 focus-within:border-gray-400 transition-colors rounded px-3 py-2 text-sm outline-none disabled:opacity-40 bg-transparent"
            />
          </label>
          {listingExpiry.error ? (
            <p className="mt-1 text-[11px] text-red-500">{listingExpiry.error}</p>
          ) : (
            <p className="mt-1 text-[11px] text-gray-400">
              Applies to the whole batch. No bids by this time and a listing
              can be expired by anyone. Leave blank for no expiry. Funds
              recipient defaults to you for every auction in this batch , 
              edit it per auction from its detail page afterward.
            </p>
          )}
        </div>
      )}

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
          disabled={isRunning || selected.size === 0 || !reserveValid || !listingTermsValid}
          className="text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
  houseVersion,
}: {
  connectedAddress: Address
  houseAddress: Address
  houseVersion: 1 | 2
}) {
  const router = useRouter()
  const [load, setLoad] = useState<CancelLoadState>({ kind: "loading" })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Snapshot of which tokens the in-flight tx is cancelling. Captured at
  // submission time so we can fire revalidation requests after the receipt
  // confirms — `selected` may change between submit and confirmation.
  const [pendingCancels, setPendingCancels] = useState<
    Array<{ contract: string; tokenId: string }>
  >([])

  // V1: one bulkCancelAuctions tx for every selected id.
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

  // V2: no bulkCancelAuctions, so N cancelAuction(id) calls through the
  // same EIP-5792-aware runner the V1-to-V2 upgrade flow uses (batched on
  // smart wallets, sequential otherwise), one per selected auction.
  const v2Cancel = useBatchedCalls()

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" })
    try {
      const auctions = await loadCancellableAuctions(houseAddress, houseVersion)
      setLoad({ kind: "loaded", auctions })
      setSelected(new Set())
    } catch (err) {
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load auctions",
      })
    }
  }, [houseAddress, houseVersion])

  useEffect(() => {
    refresh()
  }, [refresh])

  // After cancel tx confirms: refresh local + router state. The 30s
  // auction-state cache TTL covers other open browsers. (This used to
  // also POST /api/auction/revalidate per token, but that route was
  // removed in the v2 rebuild — the calls 404'd silently.)
  useEffect(() => {
    if (!isSuccess) return
    setPendingCancels([])
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
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-fg"
        >
          Try again
        </button>
      </Section>
    )
  }
  if (load.auctions.length === 0) return null

  const total = load.auctions.length
  const allSelected = selected.size === total
  const v2Running = v2Cancel.status === "running"
  const isRunning = houseVersion === 2 ? v2Running : isWritePending || isMining

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

  async function handleCancel() {
    if (load.kind !== "loaded") return
    const targets = load.auctions.filter((a) => selected.has(a.auctionId))
    if (targets.length === 0) return
    // Capture (contract, tokenId) pairs now so the post-confirm revalidation
    // can target them, `selected` may change while the cancel(s) are mining.
    setPendingCancels(
      targets.map((a) => ({ contract: a.contract, tokenId: a.tokenId })),
    )

    if (houseVersion === 2) {
      const calls: PreparedCall[] = targets.map((a) => ({
        id: a.auctionId,
        to: houseAddress,
        data: encodeFunctionData({
          abi: sovereignAuctionHouseV2Abi,
          functionName: "cancelAuction",
          args: [BigInt(a.auctionId)],
        }),
        write: {
          address: houseAddress,
          abi: sovereignAuctionHouseV2Abi,
          functionName: "cancelAuction",
          args: [BigInt(a.auctionId)],
        },
      }))
      await v2Cancel.run(calls)
      setPendingCancels([])
      router.refresh()
      await refresh()
      return
    }

    writeContract({
      address: houseAddress,
      abi: sovereignAuctionHouseAbi,
      functionName: "bulkCancelAuctions",
      args: [targets.map((a) => BigInt(a.auctionId))],
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
            {total} pre-bid {total === 1 ? "auction" : "auctions"} on your V
            {houseVersion} house
          </p>
        </div>
        <button
          onClick={toggleAll}
          disabled={isRunning}
          className="text-xs font-medium text-gray-600 hover:text-fg disabled:opacity-40"
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
              <div className="flex items-center gap-2 shrink-0">
                <p className="text-xs text-gray-400 tabular-nums">
                  Reserve {formatEther(a.reserveWei)} ETH
                </p>
                {houseVersion === 2 && v2Cancel.perItemStatus.has(a.auctionId) && (
                  <StatusChip status={v2Cancel.perItemStatus.get(a.auctionId)} />
                )}
              </div>
            }
          />
        ))}
      </Group>

      <footer className="mt-5 flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
        <p className="text-xs text-gray-500">
          {selected.size} selected
          {houseVersion === 2 && isRunning && v2Cancel.mode === "sequential" && (
            <>, {v2Cancel.walletLabel ?? "your wallet"} signs each cancel separately</>
          )}
          {houseVersion === 1 && isRunning && ", sign the cancel in your wallet"}
        </p>
        <button
          onClick={() => void handleCancel()}
          disabled={isRunning || selected.size === 0}
          className="text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {houseVersion === 2
            ? v2Running
              ? "Cancelling…"
              : `Cancel ${selected.size || ""} ${selected.size === 1 ? "auction" : "auctions"}`.replace(/\s+/g, " ").trim()
            : isWritePending
              ? "Confirm in wallet…"
              : isMining
                ? "Cancelling…"
                : `Cancel ${selected.size || ""} ${selected.size === 1 ? "auction" : "auctions"}`.replace(/\s+/g, " ").trim()}
        </button>
      </footer>

      {houseVersion === 1 && txHash && isMining && <TxLink hash={txHash} label="Pending tx:" />}
      {houseVersion === 1 && writeError && (
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
 * wallet still owns AND that don't already have an auction on the house. One
 * multicall per check type: per-token reads tripped /api/rpc's per-IP rate
 * limit on large galleries.
 */
async function loadListableItems(
  artistAddress: string,
  connectedAddress: Address,
  houseAddress: Address,
  houseVersion: 1 | 2,
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

  // Ownership + auction-existence checks as two multicalls instead of two
  // RPC reads per token. The per-token version tripped /api/rpc's per-IP
  // rate limit (429s) on large galleries.
  const ownerReads = await client.multicall({
    contracts: all.map((item) => ({
      address: item.contract as Address,
      abi: erc721Abi,
      functionName: "ownerOf" as const,
      args: [BigInt(item.tokenId)] as const,
    })),
    allowFailure: true,
  })
  const owned = all.filter((_, i) => {
    const r = ownerReads[i]
    return (
      r.status === "success" &&
      typeof r.result === "string" &&
      r.result.toLowerCase() === connectedAddress.toLowerCase()
    )
  })
  if (owned.length === 0) return []

  // V2 dropped `hasAuctionFor`; `getAuctionFor` returns (exists, auctionId)
  // instead of a plain bool.
  const auctionReads = await client.multicall({
    contracts: owned.map((item) =>
      houseVersion === 2
        ? {
            address: houseAddress,
            abi: sovereignAuctionHouseV2Abi,
            functionName: "getAuctionFor" as const,
            args: [item.contract as Address, BigInt(item.tokenId)] as const,
          }
        : {
            address: houseAddress,
            abi: sovereignAuctionHouseAbi,
            functionName: "hasAuctionFor" as const,
            args: [item.contract as Address, BigInt(item.tokenId)] as const,
          },
    ),
    allowFailure: true,
  })
  const listable = owned.filter((_, i) => {
    const r = auctionReads[i]
    // A failed read is treated as "no auction"; worst case the create tx
    // reverts on a token that already has one.
    if (r.status !== "success") return true
    if (houseVersion === 2) {
      const [exists] = r.result as readonly [boolean, bigint]
      return !exists
    }
    return r.result !== true
  })

  return listable.map((item) => ({
    contract: item.contract as Address,
    tokenId: item.tokenId,
    displayName: item.title,
    imageUrl: item.imageUrl,
  }))
}

/**
 * Load the house's cancellable auctions: indexer-nominated candidate ids
 * (one API read; the old eth_getLogs house scan exceeded the /api/rpc
 * proxy's numeric-bounds and 10k-block-span rules and could never
 * succeed), then one multicall of the house's auctions() storage as the
 * source of truth. Keep only those that:
 *   - are still in storage (`tokenOwner != 0`) — i.e. not settled or cancelled
 *   - have no bids (`firstBidTime == 0`) — the contract's only cancellable state
 */
async function loadCancellableAuctions(
  houseAddress: Address,
  houseVersion: 1 | 2,
): Promise<CancellableAuction[]> {
  const res = await fetch(`/api/house-upgrade/${houseAddress}`)
  if (!res.ok) throw new Error(`Failed to load house listings (${res.status})`)
  const { listings } = (await res.json()) as {
    listings: Array<{ auctionId: string }>
  }
  if (listings.length === 0) return []

  const client = getClient()
  const reads = await client.multicall({
    contracts: listings.map((l) => ({
      address: houseAddress,
      abi: houseVersion === 2 ? sovereignAuctionHouseV2Abi : sovereignAuctionHouseAbi,
      functionName: "auctions" as const,
      args: [BigInt(l.auctionId)] as const,
    })),
    allowFailure: true,
  })

  const cancellable: Array<{
    id: bigint
    tokenId: bigint
    tokenContract: Address
    reservePrice: bigint
  }> = []
  listings.forEach((l, i) => {
    const r = reads[i]
    if (r.status !== "success") return
    // V1's and V2's auctions() tuples agree on the first six fields
    // (tokenId, tokenContract, firstBidTime, amount, reservePrice,
    // tokenOwner); V2 adds fundsRecipient/quantity/standard after that,
    // which this read doesn't need.
    const [tokenId, tokenContract, firstBidTime, , reservePrice, tokenOwner] =
      r.result as readonly [
        bigint, // tokenId
        Address, // tokenContract
        bigint, // firstBidTime
        bigint, // amount
        bigint, // reservePrice
        Address, // tokenOwner
        ...unknown[],
      ]
    if (tokenOwner === "0x0000000000000000000000000000000000000000") return
    if (firstBidTime !== 0n) return
    cancellable.push({
      id: BigInt(l.auctionId),
      tokenId,
      tokenContract,
      reservePrice,
    })
  })

  // Resolve metadata via the public `/api/meta` route. We previously called
  // the server lib `resolveTokenMetadataDirect` directly from this client
  // component, but that pulled the lib's import graph (including the
  // pgCache → postgres chain) into the browser bundle — postgres is a
  // Node-only library and Next.js refuses to bundle it. The route returns
  // the same shape and is already 1h-cached.
  const enriched = await mapWithConcurrency(cancellable, 8, async (s) => {
    let displayName = `#${s.tokenId.toString()}`
    let imageUrl: string | null = null
    try {
      const res = await fetch(
        `/api/meta/${s.tokenContract}/${s.tokenId.toString()}`,
        { signal: AbortSignal.timeout(15_000) },
      )
      if (res.ok) {
        const json = (await res.json()) as {
          metadata?: { name?: string; image?: string } | null
          mediaUri?: string | null
        }
        if (json.metadata?.name) displayName = json.metadata.name
        if (json.mediaUri) imageUrl = json.mediaUri
        else if (json.metadata?.image) imageUrl = ipfsToHttp(json.metadata.image)
      }
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
    <div className="rounded-lg border border-gray-200 bg-surface p-5">
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
        className="h-4 w-4 shrink-0 accent-fg disabled:opacity-40"
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
