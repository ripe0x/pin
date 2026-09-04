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
import { StatusChip } from "@/components/auction/tx"
import { useBatchedCalls, type PreparedCall } from "@/lib/useBatchedCalls"
import type { HouseUpgradeListing } from "@/lib/indexer-queries"

/**
 * V1 to V2 house upgrade, two phases:
 *
 *   Phase 1: createAuctionHouse() on the V2 factory (skipped when already
 *            deployed), cancelAuction() on the V1 house per bidless
 *            listing, setApprovalForAll(v2House) per collection.
 *   Phase 2: bulkCreateAuctions() per (collection, reserve, duration) group,
 *            replaying reserve and duration for exactly the listings whose
 *            cancel completed in phase 1. bulkCreateAuctions applies one
 *            reserve/duration/listingExpiry terms set to every id in the
 *            call, so listings that differ in either need separate calls
 *            even within the same collection. Gating on phase 1 outcomes
 *            keeps a token that never returned to the wallet out of the
 *            relist call, which would revert the whole batch.
 *
 * The indexer supplies candidate listings; the V1 house's own auctions()
 * getter is then read for every row, and its values are the source of
 * truth for existence, bid state, reserve, and duration. The V2 clone
 * address is deterministic (predictHouseAddress), so approvals can
 * target the house before the deploy mines and phase 1 stays a single
 * EIP-5792 bundle on smart wallets, with a sequential per-tx fallback.
 * Listings that already have a bid cannot move: they settle on the V1
 * house under V1 rules.
 */

type Props = { artistAddress: string }

type VerifiedListing = {
  auctionId: string
  tokenContract: string
  tokenId: string
  reservePrice: bigint
  duration: bigint
  hasBid: boolean
}

// bulkCreateAuctions(tokenContract, tokenIds[], reservePrice, duration,
// listingExpiry) applies ONE terms set to every id in the call. Group
// listings so each group shares (contract, reserve, duration) exactly , 
// listingExpiry is always 0 here, there is no UI for it yet.
type RelistGroup = {
  key: string
  contract: Address
  reservePrice: bigint
  duration: bigint
  tokenIds: string[]
}

function groupForRelist(listings: VerifiedListing[]): RelistGroup[] {
  const groups = new Map<string, RelistGroup>()
  for (const l of listings) {
    const key = `${l.tokenContract}-${l.reservePrice}-${l.duration}`
    const g = groups.get(key)
    if (g) {
      g.tokenIds.push(l.tokenId)
    } else {
      groups.set(key, {
        key,
        contract: l.tokenContract as Address,
        reservePrice: l.reservePrice,
        duration: l.duration,
        tokenIds: [l.tokenId],
      })
    }
  }
  return [...groups.values()]
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
  const phase1 = useBatchedCalls()
  const phase2 = useBatchedCalls()

  const [listings, setListings] = useState<VerifiedListing[] | null>(null)
  const [staleCount, setStaleCount] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [approvedContracts, setApprovedContracts] = useState<Set<string>>(
    new Set(),
  )

  const isOwner =
    !!connected && connected.toLowerCase() === artistAddress.toLowerCase()
  const targetHouse: Address | null = v2.houseAddress ?? v2.predictedAddress

  const loadListings = useCallback(async () => {
    if (!v1.houseAddress || !publicClient) return
    setLoadError(null)
    try {
      const res = await fetch(`/api/house-upgrade/${v1.houseAddress}`)
      if (!res.ok) throw new Error(`listings unavailable (${res.status})`)
      const data = (await res.json()) as { listings: HouseUpgradeListing[] }

      // The indexer only nominates candidates. The house's own auctions()
      // getter is the source of truth: rows it no longer knows (settled or
      // cancelled since the indexer's last write) are dropped, and reserve,
      // duration, and bid state come from the chain.
      const reads = await publicClient.multicall({
        contracts: data.listings.map((l) => ({
          address: v1.houseAddress as Address,
          abi: sovereignAuctionHouseAbi,
          functionName: "auctions" as const,
          args: [BigInt(l.auctionId)] as const,
        })),
        allowFailure: true,
      })
      const verified: VerifiedListing[] = []
      let stale = 0
      data.listings.forEach((l, i) => {
        const r = reads[i]
        if (r.status !== "success") {
          stale += 1
          return
        }
        const [tokenId, tokenContract, firstBidTime, , reservePrice, tokenOwner, , , duration] =
          r.result as readonly [
            bigint, Address, bigint, bigint, bigint, Address, bigint, Address, bigint,
          ]
        if (tokenOwner === "0x0000000000000000000000000000000000000000") {
          stale += 1
          return
        }
        verified.push({
          auctionId: l.auctionId,
          tokenContract: tokenContract.toLowerCase(),
          tokenId: tokenId.toString(),
          reservePrice,
          duration,
          hasBid: BigInt(firstBidTime) !== 0n,
        })
      })
      setListings(verified)
      setStaleCount(stale)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "listings unavailable")
    }
  }, [v1.houseAddress, publicClient])

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
  const relistGroups = useMemo(() => groupForRelist(movable), [movable])

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

  const phase1Calls = useMemo((): PreparedCall[] => {
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

  const running = phase1.status === "running" || phase2.status === "running"
  const done = phase1.status === "done" && phase2.status !== "running"

  const onRun = useCallback(async () => {
    if (!targetHouse) return
    const outcomes = await phase1.run(phase1Calls)

    // The V2 house now exists (it already did, or "deploy" just landed).
    // Bust the server-side sov-house cache so the artist page's active-
    // auction gate doesn't keep pointing at the V1 house for up to its
    // 1h TTL. Best-effort, never blocks the upgrade.
    if (v2.houseAddress || outcomes.get("deploy")?.state === "done") {
      void fetch("/api/sovereign-house/revalidate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: artistAddress }),
      }).catch(() => {})
    }

    // Relist exactly what came back to the wallet: the listings whose
    // cancel completed in phase 1. Anything skipped or failed stays out,
    // so one dead row can't revert a whole relist batch.
    const returned = movable.filter(
      (l) => outcomes.get(`cancel-${l.auctionId}`)?.state === "done",
    )
    const returnedGroups = groupForRelist(returned)
    if (returnedGroups.length > 0) {
      const relistCalls: PreparedCall[] = returnedGroups.map((g) => {
        const args = [
          g.contract,
          g.tokenIds.map((id) => BigInt(id)),
          g.reservePrice,
          g.duration,
          0n,
        ] as const
        return {
          id: `relist-${g.key}`,
          to: targetHouse,
          data: encodeFunctionData({
            abi: sovereignAuctionHouseV2Abi,
            functionName: "bulkCreateAuctions",
            args,
          }),
          write: {
            address: targetHouse,
            abi: sovereignAuctionHouseV2Abi,
            functionName: "bulkCreateAuctions",
            args,
          },
        }
      })
      await phase2.run(relistCalls)
    }

    await Promise.all([loadListings(), v2.refetch()])
    router.refresh()
  }, [phase1, phase2, phase1Calls, movable, targetHouse, loadListings, v2, router])

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
              <StatusChip status={phase1.perItemStatus.get("deploy")} />
            </li>
          )}
          {movable.map((l) => (
            <li
              key={`c${l.auctionId}`}
              className="text-xs text-gray-700 flex items-center gap-2"
            >
              Cancel listing #{l.auctionId} ({formatEther(l.reservePrice)} ETH
              reserve)
              <StatusChip status={phase1.perItemStatus.get(`cancel-${l.auctionId}`)} />
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
                <StatusChip status={phase1.perItemStatus.get(`approve-${c}`)} />
              </li>
            ))}
          {relistGroups.map((g) => (
            <li
              key={`r${g.key}`}
              className="text-xs text-gray-700 flex items-center gap-2"
            >
              Relist {g.tokenIds.length} listing(s) from {g.contract.slice(0, 8)}…
              on V2 ({formatEther(g.reservePrice)} ETH reserve)
              <StatusChip status={phase2.perItemStatus.get(`relist-${g.key}`)} />
            </li>
          ))}
        </ul>
        {staleCount > 0 && (
          <p className="text-xs text-gray-500 mt-1">
            {staleCount} indexed listing(s) already ended on-chain and are
            ignored.
          </p>
        )}
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
          disabled={!isOwner || phase1Calls.length === 0 || running}
          onClick={() => void onRun()}
        >
          {running
            ? "Upgrading…"
            : done
              ? "Run again"
              : phase1.mode === "batched"
                ? `Upgrade (${phase1Calls.length + relistGroups.length} calls, batched)`
                : `Upgrade (${phase1Calls.length + relistGroups.length} transactions)`}
        </button>
        {done && (
          <button
            className="text-xs text-gray-500 underline"
            onClick={() => {
              phase1.reset()
              phase2.reset()
              void loadListings()
            }}
          >
            Refresh
          </button>
        )}
        {phase1.mode === "sequential" && phase1.walletLabel && phase1Calls.length > 1 && (
          <span className="text-xs text-gray-500">
            {phase1.walletLabel} signs each step separately.
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
