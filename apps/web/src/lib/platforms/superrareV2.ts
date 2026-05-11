import "server-only"
import {
  createPublicClient,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import {
  SUPERRARE_V2_NFT,
  SUPERRARE_BAZAAR,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import { superrareBazaarAbi } from "@pin/abi"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  CollectorTokenRef,
  AdapterLastSale,
  ActiveAuctionSummary,
  SellerListings,
  SellerCancellableAuction,
} from "./types"
import type { AuctionState, AuctionFees } from "../auctions"
import { getNFTsForOwner } from "../alchemy"
import { resolveDisplayNames } from "../artist-queries"
import {
  readSuperrareV2ArtistTokens,
  writeSuperrareV2ArtistTokens,
  readSuperrareV2Sale,
  writeSuperrareV2Sale,
  readSuperrareV2CollectorTokens,
  writeSuperrareV2CollectorTokens,
  readSuperrareV2ActiveAuctions,
  readSuperrareV2BidHistory,
  readSuperrareV2BidHistoryFreshness,
  writeSuperrareV2BidHistory,
  LAZY_TTL,
  isFresh,
} from "../lazy-index"
import type { BidHistoryEntry } from "../auctions"
import { discoverSuperrareV2ArtistAuctions } from "./superrareV2-scan"
import { getMainnetTransport } from "../alchemy-rpc"

const SR_V2_NFT = SUPERRARE_V2_NFT[MAINNET_CHAIN_ID]
const SR_BAZAAR = SUPERRARE_BAZAAR[MAINNET_CHAIN_ID]

// SuperRare V2 NFT contract was deployed in 2019. Block 8_000_000 is a
// safe lower bound (Aug 2019 — well before deploy); narrowing further
// only saves a small fraction of indexed-arg scan cost.
const SR_V2_NFT_DEPLOY_BLOCK = 8_000_000n
// SuperRare Bazaar deployed Feb 2022 (~block 14_100_000). Used as the
// lower bound for the home-grid auction scan + AuctionSettled lookups.
const SR_BAZAAR_DEPLOY_BLOCK = 14_100_000n

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
// Currency sentinel: ETH bids on Bazaar pass currencyAddress = 0x0.
// Non-zero currency = ERC-20 (rare; out of scope today).
const ETH_CURRENCY = "0x0000000000000000000000000000000000000000" as const

// Indexed-arg layouts (verified against Bazaar source on Etherscan).
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
const auctionSettledEvent = parseAbiItem(
  "event AuctionSettled(address indexed _contractAddress, address indexed _bidder, address _seller, uint256 indexed _tokenId, address _currencyAddress, uint256 _amount)",
)
// `_auctionCreator` is indexed → cheap server-side filter for "this artist's
// auctions". `_contractAddress` is also indexed but we don't constrain it
// here because the same Bazaar can host auctions on any origin contract;
// we filter to V2 NFT after the fact (per current scope).
const newAuctionEvent = parseAbiItem(
  "event NewAuction(address indexed _contractAddress, uint256 indexed _tokenId, address indexed _auctionCreator, address _currencyAddress, uint256 _startingTime, uint256 _minimumBid, uint256 _lengthOfAuction)",
)
// Bid history scan: indexed (_contractAddress, _bidder, _tokenId).
// Filter by contract + tokenId server-side; per-token returns are
// typically <30 logs even for active auctions.
const auctionBidEvent = parseAbiItem(
  "event AuctionBid(address indexed _contractAddress, address indexed _bidder, uint256 indexed _tokenId, address _currencyAddress, uint256 _amount, bool _startedAuction, uint256 _newAuctionLength, address _previousBidder)",
)

// Block-range chunk for indexed-arg log scans. Alchemy supports large
// ranges when topics are indexed (matches Foundation's BLOCK_RANGE).
const BLOCK_RANGE = 2_000_000n

// Minimal ABI for SR V2 NFT's tokenCreator(tokenId) — used to determine
// primary vs secondary sale (if seller == creator, primary).
const tokenCreatorAbi = [
  {
    type: "function",
    name: "tokenCreator",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: getMainnetTransport("superrareV2", { batch: true }),
  })
}

/**
 * Bid history for a current SR V2 auction. Mirrors the Foundation
 * pattern in `getFoundationBidHistory`: read lazy table → if fresh
 * (30 min) return; else scan AuctionBid logs for (contract, tokenId)
 * with indexed-arg filter, enrich with timestamps, persist, return.
 *
 * Note: we don't filter to "the current auction" specifically. Bazaar's
 * AuctionBid event lacks a per-listing id, so historical bids from
 * earlier auctions on the same token also match the indexed filter.
 * In practice 99% of SR V2 tokens have a single auction in their
 * lifetime; for the rare re-listed case the displayed history may
 * include older bids — acceptable for an MVP, and the sort puts
 * newest-first so current bids are at the top.
 */
async function getSuperrareV2BidHistory(
  client: ReturnType<typeof createPublicClient>,
  contract: Address,
  tokenId: string,
): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">>> {
  const freshness = await readSuperrareV2BidHistoryFreshness(contract, tokenId)
  if (freshness && isFresh(freshness, LAZY_TTL.superrareV2Bids)) {
    const cached = await readSuperrareV2BidHistory(contract, tokenId)
    if (cached) {
      return cached.map((b) => ({
        bidder: b.bidder as Address,
        amount: b.amount,
        blockTime: b.blockTime,
        txHash: b.txHash as `0x${string}`,
      }))
    }
  }

  const latest = await client.getBlockNumber()
  const logs = await paginatedIndexedScan(
    (from, to) =>
      client.getLogs({
        address: SR_BAZAAR,
        event: auctionBidEvent,
        args: { _contractAddress: contract, _tokenId: BigInt(tokenId) },
        fromBlock: from,
        toBlock: to,
      }),
    SR_BAZAAR_DEPLOY_BLOCK,
    latest,
  )

  if (logs.length === 0) return []

  // Resolve unique block timestamps (typically 1–3 unique blocks per
  // token). Each `getBlock` is ~26 CU; we dedupe to minimize cost.
  const uniqueBlocks = Array.from(
    new Set(
      logs
        .map((l) => l.blockNumber)
        .filter((b): b is bigint => b !== null),
    ),
  )
  const blockTimes = new Map<bigint, number>()
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      const block = await client.getBlock({ blockNumber: bn }).catch(() => null)
      blockTimes.set(bn, block ? Number(block.timestamp) : 0)
    }),
  )

  type Decoded = {
    bidder: Address
    amount: bigint
    txHash: `0x${string}`
    logIndex: number
    blockNumber: bigint
    blockTime: number
  }
  const decoded: Decoded[] = []
  for (const l of logs) {
    if (l.blockNumber === null || l.transactionHash === null) continue
    if (l.logIndex === null) continue
    const args = l.args as { _bidder?: Address; _amount?: bigint; _currencyAddress?: Address }
    if (!args._bidder || args._amount === undefined) continue
    // ETH-only — non-zero currency = ERC-20 (rare; out of scope).
    if (args._currencyAddress && args._currencyAddress.toLowerCase() !== ETH_CURRENCY) continue
    decoded.push({
      bidder: args._bidder,
      amount: args._amount,
      txHash: l.transactionHash,
      logIndex: l.logIndex,
      blockNumber: l.blockNumber,
      blockTime: blockTimes.get(l.blockNumber) ?? 0,
    })
  }

  // Persist all rows; the read path's freshness check uses MAX(last_indexed_at).
  writeSuperrareV2BidHistory(
    contract,
    tokenId,
    decoded.map((d) => ({
      txHash: d.txHash,
      logIndex: d.logIndex,
      bidder: d.bidder,
      amount: d.amount,
      blockTime: d.blockTime,
      blockNumber: d.blockNumber,
    })),
  )

  decoded.sort((a, b) => b.blockTime - a.blockTime)
  return decoded.map((d) => ({
    bidder: d.bidder,
    amount: d.amount,
    blockTime: d.blockTime,
    txHash: d.txHash,
  }))
}

async function paginatedIndexedScan<T>(
  scan: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<T[]> {
  const out: T[] = []
  for (let start = fromBlock; start <= toBlock; start += BLOCK_RANGE) {
    const end = start + BLOCK_RANGE - 1n > toBlock ? toBlock : start + BLOCK_RANGE - 1n
    try {
      const logs = await scan(start, end)
      out.push(...logs)
    } catch {
      // RPC may reject very large ranges; halve and retry once.
      if (end - start > 10_000n) {
        const mid = start + (end - start) / 2n
        const a = await paginatedIndexedScan(scan, start, mid)
        const b = await paginatedIndexedScan(scan, mid + 1n, end)
        out.push(...a, ...b)
      }
    }
  }
  return out
}

/**
 * SuperRare platform adapter (V2 NFT + Spaces).
 *
 * Coverage:
 *   - V2 shared 1/1 NFT contract (`0xb932a70a…`)
 *   - All SuperRare Spaces (per-Space ERC-721 contracts deployed via SR's
 *     Spaces factory; share the `tokenCreator(uint256)` interface and
 *     route through the same Bazaar marketplace contract)
 *
 * Discovery strategy (cost-bounded by indexed-arg event filters):
 *   - Artist mints (V2 NFT only): Transfer(from=0x0, to=artist). Filter
 *     is on indexed `from` + `to` so Alchemy returns only this artist's
 *     mints — typically <50 logs per artist, one cheap scan. Spaces
 *     mints are NOT yet enumerated in the artist gallery — would
 *     require either iterating known Space contracts or adding a
 *     factory enumeration. Tracked as a follow-up.
 *   - Last sale: AuctionSettled filtered by indexed `_contractAddress`
 *     and `_tokenId` on Bazaar — works for any contract Bazaar tracks.
 *     Sold/AcceptOffer events are NOT indexed by tokenId so direct-buy
 *     + offer-accept sales are NOT covered today (deferred follow-up).
 *   - Collector tokens (V2 NFT only for now): Alchemy NFT API
 *     `getNFTsForOwner` filtered to the V2 NFT contract.
 *   - Active auctions / token state: incremental scan of NewAuction /
 *     AuctionBid / AuctionSettled / CancelAuction on Bazaar populates
 *     `lazy_srv2_active_auctions` for ALL Bazaar-tracked contracts;
 *     `getActiveAuctionForToken` reads the on-chain `tokenAuctions`
 *     mapping for any (contract, tokenId), gated only by Bazaar's
 *     own zero-creator sentinel.
 *
 * Bid currency: only ETH bids (currencyAddress = 0x0) surface in our UI.
 * ERC-20 bids are rare and out of scope for the MVP.
 */
export const superrareV2Adapter: PlatformAdapter = {
  id: "superrareV2",
  displayName: "SuperRare",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    const cached = await readSuperrareV2ArtistTokens(artist)
    if (cached && isFresh(cached.lastIndexedAt, LAZY_TTL.superrareV2ArtistTokens)) {
      return cached.tokens.map((t) => ({
        platform: "superrareV2",
        contract: t.contract as Address,
        tokenId: t.tokenId,
        blockNumber: t.blockNumber,
        logIndex: t.logIndex,
        collectionName: null,
      }))
    }

    const client = getClient()
    const latest = await client.getBlockNumber()
    const logs = await paginatedIndexedScan(
      (from, to) =>
        client.getLogs({
          address: SR_V2_NFT,
          event: transferEvent,
          args: {
            from: ZERO_ADDRESS as Address,
            to: artist,
          },
          fromBlock: from,
          toBlock: to,
        }),
      SR_V2_NFT_DEPLOY_BLOCK,
      latest,
    )

    const refs = logs
      .filter(
        (l): l is typeof l & {
          blockNumber: bigint
          logIndex: number
          args: { tokenId: bigint }
        } =>
          l.blockNumber !== null &&
          l.logIndex !== null &&
          l.args.tokenId !== undefined,
      )
      .map((l) => ({
        platform: "superrareV2" as const,
        contract: SR_V2_NFT,
        tokenId: l.args.tokenId.toString(),
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        collectionName: null,
      }))

    writeSuperrareV2ArtistTokens(
      artist,
      refs.map((r) => ({
        contract: r.contract,
        tokenId: r.tokenId,
        blockNumber: r.blockNumber,
        logIndex: r.logIndex,
      })),
    )
    return refs
  },

  async discoverCollectorTokens(
    wallet: Address,
  ): Promise<CollectorTokenRef[]> {
    const cached = await readSuperrareV2CollectorTokens(wallet)
    if (cached && isFresh(cached.lastIndexedAt, LAZY_TTL.superrareV2CollectorTokens)) {
      return cached.tokens.map((t) => ({
        platform: "superrareV2",
        contract: t.contract as Address,
        tokenId: t.tokenId,
        ownerWallet: wallet,
        acquiredAtBlock: 0n,
        acquiredTxHash: null,
      }))
    }

    const owned = await getNFTsForOwner(wallet, [SR_V2_NFT])
    const refs: CollectorTokenRef[] = owned.map((o) => ({
      platform: "superrareV2",
      contract: o.contract as Address,
      tokenId: o.tokenId,
      ownerWallet: wallet,
      acquiredAtBlock: 0n,
      acquiredTxHash: null,
    }))

    writeSuperrareV2CollectorTokens(
      wallet,
      refs.map((r) => ({ contract: r.contract, tokenId: r.tokenId })),
    )
    return refs
  },

  async getLastSale(
    contract: Address,
    tokenId: string,
  ): Promise<AdapterLastSale | null> {
    // Bazaar tracks auctions across the V2 shared NFT AND every
    // SuperRare Space (per-Space ERC-721 contracts). The AuctionSettled
    // event is filtered by indexed `_contractAddress` + `_tokenId`, so
    // a contract that has never had an SR auction returns zero logs and
    // we naturally fall through to null — no need to gate on the address.

    const cached = await readSuperrareV2Sale(contract, tokenId)
    if (cached && isFresh(cached.lastIndexedAt, LAZY_TTL.superrareV2Sale)) {
      return {
        platform: "superrareV2",
        priceWei: cached.priceWei,
        blockTime: cached.blockTime,
        source: "auction",
        txHash: cached.txHash,
      }
    }

    const client = getClient()
    const latest = await client.getBlockNumber()
    const logs = await paginatedIndexedScan(
      (from, to) =>
        client.getLogs({
          address: SR_BAZAAR,
          event: auctionSettledEvent,
          args: {
            _contractAddress: contract,
            _tokenId: BigInt(tokenId),
          },
          fromBlock: from,
          toBlock: to,
        }),
      SR_BAZAAR_DEPLOY_BLOCK,
      latest,
    )

    if (logs.length === 0) return null

    const sorted = [...logs].sort((a, b) => {
      const ab = a.blockNumber ?? 0n
      const bb = b.blockNumber ?? 0n
      return ab > bb ? -1 : ab < bb ? 1 : 0
    })
    const latestLog = sorted[0] as typeof sorted[0] & {
      args: {
        _amount?: bigint
        _currencyAddress?: Address
      }
      blockNumber: bigint | null
      transactionHash: `0x${string}` | null
    }
    // Skip ERC-20 settlements; we don't surface non-ETH prices today.
    if (
      latestLog.args._currencyAddress &&
      latestLog.args._currencyAddress.toLowerCase() !== ETH_CURRENCY
    ) {
      return null
    }
    const priceWei = latestLog.args._amount ?? 0n
    if (priceWei === 0n || latestLog.blockNumber === null) return null

    const block = await client
      .getBlock({ blockNumber: latestLog.blockNumber })
      .catch(() => null)
    if (!block) return null

    const txHash = latestLog.transactionHash ?? ""
    const blockTime = Number(block.timestamp)

    writeSuperrareV2Sale(contract, tokenId, { priceWei, blockTime, txHash })

    return {
      platform: "superrareV2",
      priceWei,
      blockTime,
      source: "auction",
      txHash,
    }
  },

  async getActiveAuctionForToken(
    contract: Address,
    tokenId: string,
  ): Promise<AuctionState | null> {
    // Bazaar's tokenAuctions storage covers V2 NFT + every SR Space.
    // No address gate: contracts without an active auction return a
    // zero-creator entry and we exit on the existing zero check below.
    const client = getClient()

    // Read static auction config + live bid state. tokenAuctions returns
    // (creator, creationBlock, startingTime, lengthOfAuction, currency,
    // minimumBid, auctionType); auctionBids returns
    // (bidder, currency, amount, marketplaceFee).
    // Read static auction config, live bid, and the original token
    // creator in parallel. tokenCreator(tokenId) on the V2 NFT contract
    // returns the address that minted the token — comparing against the
    // auction's seller tells us primary vs secondary, which determines
    // the royalty/fee split per SR's pricing rules.
    const [auction, bid, tokenCreator] = await Promise.all([
      client
        .readContract({
          address: SR_BAZAAR,
          abi: superrareBazaarAbi,
          functionName: "tokenAuctions",
          args: [contract, BigInt(tokenId)],
        })
        .catch(() => null),
      client
        .readContract({
          address: SR_BAZAAR,
          abi: superrareBazaarAbi,
          functionName: "auctionBids",
          args: [contract, BigInt(tokenId)],
        })
        .catch(() => null),
      client
        .readContract({
          address: contract,
          abi: tokenCreatorAbi,
          functionName: "tokenCreator",
          args: [BigInt(tokenId)],
        })
        .catch(() => null),
    ])

    if (!auction) return null

    const [
      auctionCreator,
      ,
      startingTime,
      lengthOfAuction,
      currencyAddress,
      minimumBid,
      ,
    ] = auction as readonly [
      Address,
      bigint,
      bigint,
      bigint,
      Address,
      bigint,
      `0x${string}`,
    ]

    // No active auction: creator is zero (entry deleted on settle/cancel).
    if (auctionCreator === ZERO_ADDRESS) return null
    // ERC-20 auctions are out of scope for our UI.
    if (currencyAddress.toLowerCase() !== ETH_CURRENCY) return null

    const [bidder, , bidAmount] = (bid ?? [
      ZERO_ADDRESS as Address,
      ZERO_ADDRESS as Address,
      0n,
      0,
    ]) as readonly [Address, Address, bigint, number]

    const awaitingFirstBid = bidder === ZERO_ADDRESS || bidAmount === 0n
    // SR Bazaar: once a bid lands, `startingTime` is updated to the bid
    // block timestamp; endTime = startingTime + lengthOfAuction. Pre-bid
    // there's no live timer (treat as 0).
    const endTime = awaitingFirstBid ? 0n : startingTime + lengthOfAuction
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    const awaitingSettlement =
      !awaitingFirstBid && endTime > 0n && endTime <= nowSec

    const amount = awaitingFirstBid ? minimumBid : bidAmount
    // SR Bazaar uses a min-bid percentage (typically 10%); without a
    // contract-side getter we approximate by current+10% (or the
    // starting `minimumBid` when no bid exists).
    const minBidWei = awaitingFirstBid
      ? minimumBid
      : bidAmount + (bidAmount / 10n)

    // Bid history: parallelize with display-name resolution since both
    // are independent RPC/DB reads. Resolve ALL bidder addresses too
    // so the BidHistory component can render ENS / display names.
    const rawBids = await getSuperrareV2BidHistory(client, contract, tokenId)
    const addressesToResolve: string[] = [auctionCreator]
    if (bidder !== ZERO_ADDRESS) addressesToResolve.push(bidder)
    for (const b of rawBids) addressesToResolve.push(b.bidder)
    const names = await resolveDisplayNames(addressesToResolve)
    const lookup = (a: Address) => names.get(a.toLowerCase()) ?? a

    // SR Bazaar fee structure (per superrare.com/help/articles/10629742).
    // The 3% marketplace fee is a buyer's premium charged on top of the
    // bid amount in auctions — already shown separately in the bid form
    // ("+ 3% buyer's premium"). The bps below describe how the BID
    // AMOUNT itself is distributed at settlement, matching the existing
    // FeesBreakdown convention used by Foundation/PND auctions:
    //
    //   Primary sale  (seller IS the original creator):
    //     - Artist receives 85% of the bid (= "Seller receives" row)
    //     - SR DAO Treasury receives 15% of the bid (= "SuperRare fee" row)
    //
    //   Secondary sale (seller ≠ original creator):
    //     - Seller receives 90% of the bid
    //     - Original creator royalty: 10% of the bid
    //     - SR's only take is the 3% buyer's premium on top (no cut from
    //       the bid itself — the bid is fully distributed seller+royalty)
    //
    // We determine primary vs secondary by comparing the original
    // tokenCreator (the wallet that minted the token) against the
    // current auction's seller.
    const isPrimary =
      tokenCreator !== null &&
      typeof tokenCreator === "string" &&
      tokenCreator.toLowerCase() === auctionCreator.toLowerCase()

    // We collapse SR's two pre-seller takes into a single "SuperRare fee"
    // line so the breakdown matches the simpler Foundation/PND display.
    // On primary that's the 15% DAO Treasury cut; on secondary the 10%
    // is technically a royalty paid to the original creator (not SR
    // itself) — but from the seller's perspective both look the same:
    // a fixed % of the bid taken before the seller is paid. The creator
    // royalty row stays empty so we don't double-count.
    const fees: AuctionFees | null = isPrimary
      ? {
          platformLabel: "SuperRare",
          protocolFeeBps: 1500, // 15% of bid → SR DAO (primary)
          creatorRoyaltyBps: 0,
          sellerBps: 8500, // 85% of bid → artist
        }
      : {
          platformLabel: "SuperRare",
          protocolFeeBps: 1000, // 10% of bid → original creator (secondary royalty)
          creatorRoyaltyBps: 0,
          sellerBps: 9000, // 90% of bid → seller
        }

    return {
      source: "superrareV2",
      marketAddress: SR_BAZAAR,
      auctionId: `${contract.toLowerCase()}:${tokenId}`,
      nftContract: contract,
      tokenId,
      seller: auctionCreator,
      sellerDisplay: lookup(auctionCreator),
      amount,
      bidder,
      bidderDisplay: bidder === ZERO_ADDRESS ? "" : lookup(bidder),
      endTime,
      duration: lengthOfAuction,
      minBidWei,
      awaitingFirstBid,
      awaitingSettlement,
      fees,
      bidHistory: rawBids.map((b) => ({
        ...b,
        bidderDisplay: lookup(b.bidder),
      })),
    }
  },

  /**
   * Cancellable SR V2 auctions for `seller`. Bazaar exposes
   * `cancelAuction(originContract, tokenId)` which reverts on:
   *   - non-seller caller (we already filter by indexed `_auctionCreator`)
   *   - any bid received post-creation (auctions become uncancellable as
   *     soon as `auctionBids[contract][tokenId].bidder != 0x0`)
   *   - non-ETH currency (out of scope for the migrate flow today —
   *     Sovereign houses are ETH-only, so we drop ERC-20 auctions)
   *
   * No buy-nows are returned: SuperRare's "fixed price" listings live in
   * a separate `salePrice` mapping and aren't part of the Sovereign-
   * destined migrate flow today.
   */
  async getCancellableListingsForSeller(
    seller: Address,
  ): Promise<SellerListings | null> {
    const client = getClient()
    const latest = await client.getBlockNumber()

    // Indexed-arg event filter: Bazaar's NewAuction has `_auctionCreator`
    // indexed, so this returns ONLY this seller's auctions across the
    // platform's lifetime. Typically a handful of logs per artist.
    const logs = await paginatedIndexedScan(
      (from, to) =>
        client.getLogs({
          address: SR_BAZAAR,
          event: newAuctionEvent,
          args: { _auctionCreator: seller },
          fromBlock: from,
          toBlock: to,
        }),
      SR_BAZAAR_DEPLOY_BLOCK,
      latest,
    )

    if (logs.length === 0) return { auctions: [], buyNows: [] }

    // Dedupe by (contract, tokenId): SR auctions are keyed on the token
    // (one auction per token at a time on Bazaar), so a re-listed token
    // surfaces multiple NewAuction events. Keep the most recent by
    // blockNumber so we use the latest configured length/min bid; the
    // post-multicall confirmation drops anything that's no longer live.
    type AuctionMeta = {
      contract: Address
      tokenId: bigint
      lengthOfAuction: bigint
      minimumBid: bigint
      currencyAddress: Address
      blockNumber: bigint
    }
    const byKey = new Map<string, AuctionMeta>()
    for (const log of logs) {
      const l = log as typeof log & {
        args: {
          _contractAddress: Address
          _tokenId: bigint
          _currencyAddress: Address
          _minimumBid: bigint
          _lengthOfAuction: bigint
        }
        blockNumber: bigint | null
      }
      if (l.blockNumber === null) continue
      // ERC-20 auctions: skip — Sovereign houses don't support non-ETH.
      if (l.args._currencyAddress.toLowerCase() !== ETH_CURRENCY) continue
      const key = `${l.args._contractAddress.toLowerCase()}:${l.args._tokenId.toString()}`
      const prev = byKey.get(key)
      if (!prev || l.blockNumber > prev.blockNumber) {
        byKey.set(key, {
          contract: l.args._contractAddress,
          tokenId: l.args._tokenId,
          lengthOfAuction: l.args._lengthOfAuction,
          minimumBid: l.args._minimumBid,
          currencyAddress: l.args._currencyAddress,
          blockNumber: l.blockNumber,
        })
      }
    }

    const candidates = Array.from(byKey.values())
    if (candidates.length === 0) return { auctions: [], buyNows: [] }

    // Multicall the live auction state + the current NFT owner. Three
    // checks must all pass for an auction to be cancellable:
    //   1. tokenAuctions[contract][tokenId].auctionCreator == seller
    //      (storage entry exists and is ours).
    //   2. auctionBids[contract][tokenId].bidder == 0x0 (cancelAuction
    //      reverts as soon as a bid lands).
    //   3. ownerOf(tokenId) ∈ {seller, BAZAAR}. The two cases:
    //      - COLDIE_AUCTION (~95% of auctions): Bazaar uses an approval-
    //        based flow, so the token stays with the seller until
    //        settle. ownerOf == seller while live.
    //      - SCHEDULED_AUCTION (~5%): Bazaar pulls custody on
    //        configureAuction (because start can be days/weeks in the
    //        future and approval-based would let the seller rug
    //        trivially). ownerOf == BAZAAR while live.
    //      A token at any other address is post-settle / post-rug-
    //      transfer and the cancel call would revert internally.
    const out: SellerCancellableAuction[] = []
    const sellerLower = seller.toLowerCase()
    const ownerOfAbi = [
      {
        type: "function" as const,
        name: "ownerOf",
        stateMutability: "view" as const,
        inputs: [{ name: "tokenId", type: "uint256" as const }],
        outputs: [{ name: "", type: "address" as const }],
      },
    ]
    for (let i = 0; i < candidates.length; i += 50) {
      const batch = candidates.slice(i, i + 50)
      const calls = batch.flatMap((c) => [
        {
          address: SR_BAZAAR,
          abi: superrareBazaarAbi,
          functionName: "tokenAuctions" as const,
          args: [c.contract, c.tokenId] as const,
        },
        {
          address: SR_BAZAAR,
          abi: superrareBazaarAbi,
          functionName: "auctionBids" as const,
          args: [c.contract, c.tokenId] as const,
        },
        {
          address: c.contract,
          abi: ownerOfAbi,
          functionName: "ownerOf" as const,
          args: [c.tokenId] as const,
        },
        // tokenCreator → primary vs secondary classification. Primary
        // (creator == seller) → 15% to SR DAO. Secondary → 10% to the
        // original creator royalty. The migrate panel reads this back
        // to render the exact fee delta per row instead of "up to 15%".
        {
          address: c.contract,
          abi: tokenCreatorAbi,
          functionName: "tokenCreator" as const,
          args: [c.tokenId] as const,
        },
      ])
      const results = await client.multicall({ contracts: calls })
      batch.forEach((c, j) => {
        const auctionRes = results[j * 4]
        const bidRes = results[j * 4 + 1]
        const ownerRes = results[j * 4 + 2]
        const creatorRes = results[j * 4 + 3]
        if (
          auctionRes.status !== "success" ||
          bidRes.status !== "success" ||
          ownerRes.status !== "success"
        ) {
          return
        }
        const a = auctionRes.result as readonly [
          Address, // auctionCreator
          bigint, // creationBlock
          bigint, // startingTime
          bigint, // lengthOfAuction
          Address, // currencyAddress
          bigint, // minimumBid
          `0x${string}`, // auctionType
        ]
        const auctionCreator = a[0]
        const currencyAddress = a[4]
        const minimumBidLive = a[5]
        if (auctionCreator === ZERO_ADDRESS) return
        if (auctionCreator.toLowerCase() !== sellerLower) return
        if (currencyAddress.toLowerCase() !== ETH_CURRENCY) return

        const b = bidRes.result as readonly [
          Address, // bidder
          Address, // currencyAddress
          bigint, // amount
          number, // marketplaceFee
        ]
        const bidder = b[0]
        const bidAmount = b[2]
        if (bidder !== ZERO_ADDRESS && bidAmount !== 0n) return

        // Multicall typings narrow per-call based on the union ABI; the
        // cast to unknown lets us pin to Address without TS complaining
        // about overlap with the tokenAuctions/auctionBids tuples.
        const owner = ownerRes.result as unknown as Address
        const ownerLower = owner.toLowerCase()
        const isLive =
          ownerLower === sellerLower ||
          ownerLower === SR_BAZAAR.toLowerCase()
        if (!isLive) return

        // Compute exact fee bps: primary if the original minter still
        // holds the seller role on this auction; secondary otherwise.
        // tokenCreator() reverts on tokens that don't expose it (rare —
        // a few SR collection forks); fall back to undefined so the
        // panel renders the platform default.
        let feeBps: number | undefined
        if (creatorRes.status === "success") {
          const creator = creatorRes.result as unknown as Address
          const isPrimary = creator.toLowerCase() === sellerLower
          feeBps = isPrimary ? 1500 : 1000
        }

        out.push({
          id: `srv2:auction:${c.contract.toLowerCase()}:${c.tokenId.toString()}`,
          platform: "superrareV2",
          auctionId: `${c.contract.toLowerCase()}:${c.tokenId.toString()}`,
          nftContract: c.contract,
          tokenId: c.tokenId.toString(),
          reserveWei: minimumBidLive.toString(),
          durationSeconds: Number(c.lengthOfAuction),
          feeBps,
        })
      })
    }

    return { auctions: out, buyNows: [] }
  },

  async discoverArtistAuctions(artist: Address): Promise<void> {
    await discoverSuperrareV2ArtistAuctions(artist)
  },

  async getActiveAuctions(limit: number): Promise<ActiveAuctionSummary[]> {
    // Pure table read — no RPC in the home-grid request path. The
    // per-artist scanner runs from artist-page loads via
    // `discoverArtistAuctions`, populating the table for whoever's
    // been visited. Reads JOIN the per-artist status table with a
    // 24h freshness filter so unvisited artists drop out.
    // Over-read so the artist-seller filter doesn't shrink the result
    // set below `limit` when many active rows are secondary listings.
    const rows = await readSuperrareV2ActiveAuctions(limit * 4)
    return rows
      .filter(
        (r) =>
          r.creator !== null &&
          r.creator.toLowerCase() === r.seller.toLowerCase(),
      )
      .slice(0, limit)
      .map((r) => ({
        platform: "superrareV2",
        contract: r.contract as Address,
        tokenId: r.tokenId,
        seller: r.seller as Address,
        reserveWei: r.reserveWei,
        currentBidWei: r.currentBidWei,
        currentBidder: (r.currentBidder ?? null) as Address | null,
        endTime: r.endTime,
        sourceContract: SR_BAZAAR,
      }))
  },
}
