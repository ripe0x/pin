"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useAccount, usePublicClient } from "wagmi"
import { encodeFunctionData, erc721Abi, formatEther, type Address } from "viem"
import {
  sovereignAuctionHouseAbi,
  sovereignAuctionHouseV2Abi,
  sovereignAuctionHouseV2FactoryAbi,
} from "@pin/abi"
import { useArtistHouse } from "@/components/auction/useArtistHouse"
import { useArtistHouseV2 } from "@/components/auction/useArtistHouseV2"
import {
  useBatchedCalls,
  type ItemStatus,
  type PreparedCall,
} from "@/lib/useBatchedCalls"
import type { HouseUpgradeListing } from "@/lib/indexer-queries"

/**
 * V1 to V2 house upgrade. Composes one ordered run:
 *
 *   1. createAuctionHouse() on the V2 factory (skipped when already deployed)
 *   2. cancelAuction() on the V1 house for every listing without a bid
 *   3. setApprovalForAll(v2House) per collection (skipped when already set)
 *   4. bulkCreateAuctionsWithSettings() per collection, replaying each
 *      listing's reserve and duration
 *
 * The V2 clone address is deterministic (predictHouseAddress), so steps
 * 3 and 4 can target the house before step 1 mines — the whole run works
 * as one EIP-5792 bundle on smart wallets, with a sequential per-tx
 * fallback for everything else. Listings that already have a bid cannot
 * move: they settle on the V1 house under V1 rules.
 */

type Props = { artistAddress: string }

const STATUS_LABEL: Record<ItemStatus["state"], string> = {
  idle: "Queued",
  confirming: "Awaiting signature",
  mining: "Confirming",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
}

function StatusChip({ status }: { status: ItemStatus | undefined }) {
  const state = status?.state ?? "idle"
  const tone =
    state === "done"
      ? "text-green-700 bg-green-50"
      : state === "failed"
        ? "text-red-700 bg-red-50"
        : state === "skipped"
          ? "text-gray-500 bg-gray-100"
          : "text-gray-700 bg-gray-100"
  const detail =
    status?.state === "failed"
      ? `: ${status.error}`
      : status?.state === "skipped"
        ? `: ${status.reason}`
        : ""
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded ${tone}`}>
      {STATUS_LABEL[state]}
      {detail}
    </span>
  )
}

export function HouseUpgradePanel({ artistAddress }: Props) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <Panel artistAddress={artistAddress} />
}

function Panel({ artistAddress }: Props) {
  const router = useRouter()
  const { address: connected } = useAccount()
  const publicClient = usePublicClient()
  const v1 = useArtistHouse(artistAddress)
  const v2 = useArtistHouseV2(artistAddress)
  const { run, reset, status, perItemStatus, mode, walletLabel } =
    useBatchedCalls()

  const [listings, setListings] = useState<HouseUpgradeListing[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [approvedContracts, setApprovedContracts] = useState<Set<string>>(
    new Set(),
  )

  const isOwner =
    !!connected && connected.toLowerCase() === artistAddress.toLowerCase()
  const targetHouse: Address | null = v2.houseAddress ?? v2.predictedAddress

  const loadListings = useCallback(async () => {
    if (!v1.houseAddress) return
    setLoadError(null)
    try {
      const res = await fetch(`/api/house-upgrade/${v1.houseAddress}`)
      if (!res.ok) throw new Error(`listings unavailable (${res.status})`)
      const data = (await res.json()) as { listings: HouseUpgradeListing[] }
      setListings(data.listings)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "listings unavailable")
    }
  }, [v1.houseAddress])

  useEffect(() => {
    void loadListings()
  }, [loadListings])

  const movable = useMemo(
    () => (listings ?? []).filter((l) => !l.hasBid),
    [listings],
  )
  const inFlight = useMemo(
    () => (listings ?? []).filter((l) => l.hasBid),
    [listings],
  )
  const collections = useMemo(
    () => [...new Set(movable.map((l) => l.tokenContract))],
    [movable],
  )

  // One multicall for the per-collection approval state against the
  // target house, so already-approved collections skip their step.
  useEffect(() => {
    if (!publicClient || !targetHouse || collections.length === 0 || !connected)
      return
    let cancelled = false
    void (async () => {
      try {
        const results = await publicClient.multicall({
          contracts: collections.map((c) => ({
            address: c as Address,
            abi: erc721Abi,
            functionName: "isApprovedForAll" as const,
            args: [connected, targetHouse] as const,
          })),
          allowFailure: true,
        })
        if (cancelled) return
        const approved = new Set<string>()
        collections.forEach((c, i) => {
          const r = results[i]
          if (r.status === "success" && r.result === true) approved.add(c)
        })
        setApprovedContracts(approved)
      } catch {
        // Treat as not approved; the approval call is a harmless repeat.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [publicClient, targetHouse, collections, connected])

  const calls = useMemo((): PreparedCall[] => {
    if (!v1.houseAddress || !targetHouse || !v2.factoryAddress) return []
    const out: PreparedCall[] = []

    if (!v2.houseAddress) {
      out.push({
        id: "deploy",
        to: v2.factoryAddress,
        data: encodeFunctionData({
          abi: sovereignAuctionHouseV2FactoryAbi,
          functionName: "createAuctionHouse",
        }),
        write: {
          address: v2.factoryAddress,
          abi: sovereignAuctionHouseV2FactoryAbi,
          functionName: "createAuctionHouse",
          args: [],
        },
        skipReason: "House already deployed",
      })
    }

    for (const l of movable) {
      out.push({
        id: `cancel-${l.auctionId}`,
        to: v1.houseAddress,
        data: encodeFunctionData({
          abi: sovereignAuctionHouseAbi,
          functionName: "cancelAuction",
          args: [BigInt(l.auctionId)],
        }),
        write: {
          address: v1.houseAddress,
          abi: sovereignAuctionHouseAbi,
          functionName: "cancelAuction",
          args: [BigInt(l.auctionId)],
        },
        skipReason: "Listing no longer cancellable (a bid landed or it settled)",
      })
    }

    for (const contract of collections) {
      if (approvedContracts.has(contract)) continue
      out.push({
        id: `approve-${contract}`,
        to: contract as Address,
        data: encodeFunctionData({
          abi: erc721Abi,
          functionName: "setApprovalForAll",
          args: [targetHouse, true],
        }),
        write: {
          address: contract as Address,
          abi: erc721Abi,
          functionName: "setApprovalForAll",
          args: [targetHouse, true],
        },
      })
    }

    for (const contract of collections) {
      const lots = movable
        .filter((l) => l.tokenContract === contract)
        .map((l) => ({
          tokenId: BigInt(l.tokenId),
          reservePrice: BigInt(l.reservePrice),
          duration: BigInt(l.duration),
          fundsRecipient:
            "0x0000000000000000000000000000000000000000" as Address,
          listingExpiry: 0n,
        }))
      out.push({
        id: `relist-${contract}`,
        to: targetHouse,
        data: encodeFunctionData({
          abi: sovereignAuctionHouseV2Abi,
          functionName: "bulkCreateAuctionsWithSettings",
          args: [contract as Address, lots],
        }),
        write: {
          address: targetHouse,
          abi: sovereignAuctionHouseV2Abi,
          functionName: "bulkCreateAuctionsWithSettings",
          args: [contract as Address, lots],
        },
        // Valid only after the cancels (and deploy) in this same run, so
        // the estimateGas preflight against current state would always
        // condemn it.
        skipPreflight: true,
      })
    }

    return out
  }, [
    v1.houseAddress,
    v2.houseAddress,
    v2.factoryAddress,
    targetHouse,
    movable,
    collections,
    approvedContracts,
  ])

  const done = status === "done"

  const onRun = useCallback(async () => {
    await run(calls)
    await Promise.all([loadListings(), v2.refetch()])
    router.refresh()
  }, [run, calls, loadListings, v2, router])

  // Fold away entirely before the V2 factory ships, and for artists with
  // no V1 house (nothing to upgrade). The panel is mounted on the shared
  // migrate page, so absence is the correct empty state.
  if (!v2.factoryAddress || (!v1.isLoading && !v1.houseAddress)) return null

  if (v1.isLoading || (v1.houseAddress && listings === null && !loadError)) {
    return (
      <Card title="Upgrade your auction house">
        <p className="text-sm text-gray-500">Loading your listings…</p>
      </Card>
    )
  }

  if (!v1.houseAddress) return null

  return (
    <Card title="Upgrade your auction house">
      <p className="text-sm text-gray-600 mb-4">
        Moves your open listings from your V1 house to a V2 house. Each
        listing is cancelled on V1 and recreated on V2 with the same reserve
        price and duration. Listings that already have a bid stay on V1
        until they settle.
      </p>

      {loadError && (
        <p className="text-sm text-red-700 mb-4">
          {loadError}.{" "}
          <button className="underline" onClick={() => void loadListings()}>
            Retry
          </button>
        </p>
      )}

      {!isOwner && (
        <p className="text-sm text-amber-700 mb-4">
          Connect the wallet that owns this house ({artistAddress}) to run
          the upgrade.
        </p>
      )}

      <div className="mb-4">
        <h3 className="text-xs font-semibold text-gray-900 mb-1">Steps</h3>
        <ul className="space-y-1">
          {!v2.houseAddress && (
            <li className="text-xs text-gray-700 flex items-center gap-2">
              Deploy V2 house
              <StatusChip status={perItemStatus.get("deploy")} />
            </li>
          )}
          {movable.map((l) => (
            <li
              key={`c${l.auctionId}`}
              className="text-xs text-gray-700 flex items-center gap-2"
            >
              Cancel listing #{l.auctionId} ({formatEther(BigInt(l.reservePrice))}{" "}
              ETH reserve)
              <StatusChip status={perItemStatus.get(`cancel-${l.auctionId}`)} />
            </li>
          ))}
          {collections
            .filter((c) => !approvedContracts.has(c))
            .map((c) => (
              <li
                key={`a${c}`}
                className="text-xs text-gray-700 flex items-center gap-2"
              >
                Approve {c.slice(0, 8)}… for the V2 house
                <StatusChip status={perItemStatus.get(`approve-${c}`)} />
              </li>
            ))}
          {collections.map((c) => (
            <li
              key={`r${c}`}
              className="text-xs text-gray-700 flex items-center gap-2"
            >
              Relist {movable.filter((l) => l.tokenContract === c).length}{" "}
              listing(s) from {c.slice(0, 8)}… on V2
              <StatusChip status={perItemStatus.get(`relist-${c}`)} />
            </li>
          ))}
        </ul>
      </div>

      {inFlight.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-gray-900 mb-1">
            Staying on V1 (live bids)
          </h3>
          <p className="text-xs text-gray-500 mb-1">
            These auctions have bids and settle on your V1 house under V1
            rules. Once settled or ended, relist new work on V2.
          </p>
          <ul className="space-y-0.5">
            {inFlight.map((l) => (
              <li key={l.auctionId} className="text-xs text-gray-700">
                Listing #{l.auctionId}, token {l.tokenId} of{" "}
                {l.tokenContract.slice(0, 8)}…
              </li>
            ))}
          </ul>
        </div>
      )}

      {movable.length === 0 && !v2.houseAddress ? (
        <p className="text-xs text-gray-500 mb-4">
          No open listings to move. Running the upgrade just deploys your V2
          house.
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          className="text-sm px-3 py-1.5 rounded bg-gray-900 text-white disabled:opacity-40"
          disabled={!isOwner || calls.length === 0 || status === "running"}
          onClick={() => void onRun()}
        >
          {status === "running"
            ? "Upgrading…"
            : done
              ? "Run again"
              : mode === "batched"
                ? `Upgrade (${calls.length} calls, batched)`
                : `Upgrade (${calls.length} transactions)`}
        </button>
        {done && (
          <button
            className="text-xs text-gray-500 underline"
            onClick={() => {
              reset()
              void loadListings()
            }}
          >
            Refresh
          </button>
        )}
        {mode === "sequential" && walletLabel && calls.length > 1 && (
          <span className="text-xs text-gray-500">
            {walletLabel} signs each step separately.
          </span>
        )}
      </div>
    </Card>
  )
}

function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-900 mb-2">{title}</h2>
      {children}
    </section>
  )
}
