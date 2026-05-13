import "server-only"
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { SUPERRARE_BAZAAR, MAINNET_CHAIN_ID } from "@pin/addresses"
import {
  writeSuperrareV2ActiveAuctions,
  readSrv2ArtistAuctionStatus,
  writeSrv2ArtistAuctionStatus,
  LAZY_TTL,
  isFresh,
  type LazySuperrareV2ActiveAuction,
} from "../lazy-index"
import { getMainnetRpcUrl } from "../rpc"

const SR_BAZAAR = SUPERRARE_BAZAAR[MAINNET_CHAIN_ID]
// Bazaar deployed Feb 2022 (~14_100_000). Per-artist `getLogs` calls
// filter on indexed _auctionCreator / _contractAddress / _tokenId
// topics, so the RPC returns only this artist's events regardless of
// how wide the block range is.
const SR_BAZAAR_DEPLOY_BLOCK = 14_100_000n
const COOLDOWN_MS = LAZY_TTL.superrareV2ArtistAuctions

const newAuctionEvent = parseAbiItem(
  "event NewAuction(address indexed _contractAddress, uint256 indexed _tokenId, address indexed _auctionCreator, address _currencyAddress, uint256 _startingTime, uint256 _minimumBid, uint256 _lengthOfAuction)",
)
const auctionBidEvent = parseAbiItem(
  "event AuctionBid(address indexed _contractAddress, address indexed _bidder, uint256 indexed _tokenId, address _currencyAddress, uint256 _amount, bool _startedAuction, uint256 _newAuctionLength, address _previousBidder)",
)
const auctionSettledEvent = parseAbiItem(
  "event AuctionSettled(address indexed _contractAddress, address indexed _bidder, address _seller, uint256 indexed _tokenId, address _currencyAddress, uint256 _amount)",
)
const cancelAuctionEvent = parseAbiItem(
  "event CancelAuction(address indexed _contractAddress, uint256 indexed _tokenId, address indexed _auctionCreator)",
)

const ETH_CURRENCY = "0x0000000000000000000000000000000000000000"

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      getMainnetRpcUrl(),
      { batch: true },
    ),
  })
}

const tokenCreatorAbi = [
  {
    type: "function",
    name: "tokenCreator",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const

function tokenKey(contract: string, tokenId: string): string {
  return `${contract.toLowerCase()}:${tokenId}`
}

/**
 * Lazy-index this artist's SR V2 Bazaar reserve auctions.
 *
 * Two-phase event walk, per-artist:
 *
 *   1. `NewAuction` filtered by `_auctionCreator=artist` (indexed
 *      topic) — gives every auction where this address is the lister.
 *      The RPC returns only this artist's logs from the contract's
 *      deploy block forward.
 *   2. For the union of (contract, tokenId) pairs collected above,
 *      run `AuctionBid` / `AuctionSettled` / `CancelAuction` in
 *      parallel. Bid + Settled don't have an `_auctionCreator` topic,
 *      so we filter by `_contractAddress` + `_tokenId` arrays
 *      (topic-OR within each, AND across) and discard any returned
 *      logs whose (contract, tokenId) isn't actually in our scoped
 *      set (handles the AND-across-fields false-positive case).
 *      Cancel filters cleanly on `_auctionCreator`.
 *
 * Reduces the union of events to current state and upserts into
 * `lazy_srv2_active_auctions`. Stamps the artist's status row at the
 * end so the home grid's 24h freshness join surfaces them. Self-cools
 * via `LAZY_TTL.superrareV2ArtistAuctions` (2 min).
 */
export async function discoverSuperrareV2ArtistAuctions(
  artist: Address,
): Promise<void> {
  const status = await readSrv2ArtistAuctionStatus(artist)
  if (status && isFresh(status.lastIndexedAt, COOLDOWN_MS)) return

  const client = getClient()
  const fromBlock = SR_BAZAAR_DEPLOY_BLOCK
  const sellerLower = artist.toLowerCase() as Address

  // Phase 1 — every auction this artist has created.
  const newAuctionLogs = await client.getLogs({
    address: SR_BAZAAR,
    event: newAuctionEvent,
    args: { _auctionCreator: sellerLower },
    fromBlock,
  })

  if (newAuctionLogs.length === 0) {
    await writeSrv2ArtistAuctionStatus(sellerLower)
    return
  }

  const byKey = new Map<string, LazySuperrareV2ActiveAuction>()
  const contractsSet = new Set<Address>()
  const tokenIdsSet = new Set<bigint>()
  for (const l of newAuctionLogs) {
    const contractAddr = l.args._contractAddress
    const tokenIdRaw = l.args._tokenId
    const minBid = l.args._minimumBid
    const currency = l.args._currencyAddress
    if (
      contractAddr === undefined ||
      tokenIdRaw === undefined ||
      minBid === undefined ||
      currency === undefined
    ) {
      continue
    }
    if (currency.toLowerCase() !== ETH_CURRENCY) continue
    const contractLower = contractAddr.toLowerCase()
    const tokenId = tokenIdRaw.toString()
    contractsSet.add(contractAddr)
    tokenIdsSet.add(tokenIdRaw)
    byKey.set(tokenKey(contractLower, tokenId), {
      contract: contractLower,
      tokenId,
      seller: sellerLower,
      reserveWei: minBid,
      currentBidWei: 0n,
      currentBidder: null,
      endTime: 0,
      status: "active",
      startedAtBlock: l.blockNumber ?? 0n,
      creator: null,
    })
  }

  if (byKey.size === 0) {
    // All listings were ERC-20 priced (skipped); still mark fresh.
    await writeSrv2ArtistAuctionStatus(sellerLower)
    return
  }

  const contracts = Array.from(contractsSet)
  const tokenIds = Array.from(tokenIdsSet)

  // Phase 2 — Bid/Settled (filter by contract+tokenId arrays) and
  // Cancel (filter by _auctionCreator). Bid + Settled use AND-across-
  // fields, so a contract-token pair the artist doesn't own can match
  // if both arrays happen to include its parts. Filter client-side.
  const [bidLogs, settledLogs, cancelLogs] = await Promise.all([
    client.getLogs({
      address: SR_BAZAAR,
      event: auctionBidEvent,
      args: { _contractAddress: contracts, _tokenId: tokenIds },
      fromBlock,
    }),
    client.getLogs({
      address: SR_BAZAAR,
      event: auctionSettledEvent,
      args: { _contractAddress: contracts, _tokenId: tokenIds },
      fromBlock,
    }),
    client.getLogs({
      address: SR_BAZAAR,
      event: cancelAuctionEvent,
      args: { _auctionCreator: sellerLower },
      fromBlock,
    }),
  ])

  type AppliedLog = {
    blockNumber: bigint | null
    logIndex: number | null
    kind: "bid" | "settled" | "cancel"
    args:
      | (typeof bidLogs)[number]["args"]
      | (typeof settledLogs)[number]["args"]
      | (typeof cancelLogs)[number]["args"]
  }
  const applied: AppliedLog[] = [
    ...bidLogs.map((l) => ({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "bid" as const,
      args: l.args,
    })),
    ...settledLogs.map((l) => ({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "settled" as const,
      args: l.args,
    })),
    ...cancelLogs.map((l) => ({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "cancel" as const,
      args: l.args,
    })),
  ]
  applied.sort((a, b) => {
    const ab = a.blockNumber ?? 0n
    const bb = b.blockNumber ?? 0n
    if (ab !== bb) return ab > bb ? 1 : -1
    return (a.logIndex ?? 0) - (b.logIndex ?? 0)
  })

  for (const l of applied) {
    const contractRaw = l.args._contractAddress
    const tokenIdRaw = l.args._tokenId
    if (contractRaw === undefined || tokenIdRaw === undefined) continue
    const key = tokenKey(contractRaw, tokenIdRaw.toString())
    const existing = byKey.get(key)
    if (!existing) continue // false positive from AND-across topic filter

    if (l.kind === "bid") {
      const args = l.args as (typeof bidLogs)[number]["args"]
      if (args._currencyAddress?.toLowerCase() !== ETH_CURRENCY) continue
      const amount = args._amount
      const newLength = args._newAuctionLength
      const bidder = args._bidder
      if (amount !== undefined) existing.currentBidWei = amount
      if (bidder !== undefined) existing.currentBidder = bidder.toLowerCase()
      // SR Bazaar emits `_newAuctionLength` on each bid; the on-chain
      // auction.startingTime is set on first bid to the block ts, and
      // endTime = startingTime + newLength. Without a per-bid block
      // timestamp here we approximate to `Date.now()` at scan time
      // — the documented upstream bug. Fixing it (use
      // `eth_getBlockByNumber` per bid block, or read the live
      // auction state via `tokenAuctions(...)` for active rows) is
      // out of scope for the per-artist refactor.
      if (newLength !== undefined) {
        existing.endTime = Math.floor(Date.now() / 1000) + Number(newLength)
      }
    } else if (l.kind === "settled") {
      existing.status = "settled"
    } else if (l.kind === "cancel") {
      existing.status = "cancelled"
    }
  }

  // Backfill `creator` via tokenCreator(). For SR V2 the bazaar's
  // `_auctionCreator` is whoever's listing — may be a collector
  // reselling a primary mint. The home-grid filter `creator = seller`
  // keeps only primary-art listings.
  const needsCreator = [...byKey.values()].filter(
    (r) => r.status === "active" && !r.creator,
  )
  // Multicall chunks. Single-batch eth_call response can exceed RPC
  // size limits when an artist has hundreds of auctions; chunk to a
  // safe size that consistently clears Alchemy / public RPC caps.
  const MULTICALL_CHUNK = 100
  for (let i = 0; i < needsCreator.length; i += MULTICALL_CHUNK) {
    const slice = needsCreator.slice(i, i + MULTICALL_CHUNK)
    try {
      const tcResults = await client.multicall({
        contracts: slice.map((r) => ({
          address: r.contract as Address,
          abi: tokenCreatorAbi,
          functionName: "tokenCreator" as const,
          args: [BigInt(r.tokenId)],
        })),
        allowFailure: true,
      })
      for (let j = 0; j < slice.length; j++) {
        const res = tcResults[j]
        if (res?.status === "success" && typeof res.result === "string") {
          slice[j].creator = (res.result as string).toLowerCase()
        }
      }
    } catch {
      // Chunk failure leaves those rows null; next scan retries.
    }
  }

  if (byKey.size > 0) {
    writeSuperrareV2ActiveAuctions([...byKey.values()])
  }
  await writeSrv2ArtistAuctionStatus(sellerLower)
}
