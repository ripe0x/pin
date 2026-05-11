import "server-only"
import {
  createPublicClient,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import {
  TL_AUCTION_HOUSE,
  TL_UNIVERSAL_DEPLOYER,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import { transientAuctionHouseAbi } from "@pin/abi"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  CollectorTokenRef,
  AdapterLastSale,
  ActiveAuctionSummary,
} from "./types"
import type { AuctionState, AuctionFees } from "../auctions"
import { resolveDisplayNames } from "../artist-queries"
import {
  readTransientSale,
  writeTransientSale,
  readTransientActiveAuctions,
  readTransientBidHistory,
  readTransientBidHistoryFreshness,
  writeTransientBidHistory,
  readTransientArtistTokens,
  writeTransientArtistTokens,
  LAZY_TTL,
  isFresh,
} from "../lazy-index"
import type { BidHistoryEntry } from "../auctions"
import { discoverTransientArtistAuctions } from "./transient-scan"
import { getMainnetTransport } from "../alchemy-rpc"

const TL_AH = TL_AUCTION_HOUSE[MAINNET_CHAIN_ID]
const TL_DEPLOYER = TL_UNIVERSAL_DEPLOYER[MAINNET_CHAIN_ID]

// TL Auction House v2.6.1 was deployed in early 2026. Block 24_500_000
// (~Mar 2026) is a safe lower bound that comfortably pre-dates the
// deploy; narrowing further only saves a small fraction of indexed-arg
// scan cost. Confirmed via the address's first events being well
// after this block.
const TL_AUCTION_HOUSE_DEPLOY_BLOCK = 24_500_000n

// Universal Deployer was created at block 19,062,900 (Jan 22, 2024).
// All ERC721TL / ERC1155TL minimal-proxy clones get deployed via
// `ContractDeployed` events from this address. Used as the lower
// bound for the artist-gallery scan that finds an artist's contracts.
const TL_DEPLOYER_DEPLOY_BLOCK = 19_062_900n

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
// Currency sentinel: ETH listings use currencyAddress = address(0).
const ETH_CURRENCY = "0x0000000000000000000000000000000000000000" as const

// Listing.type_ enum values (probed from live listings on the verified
// source). 0 = NOT_CONFIGURED, others are auction/buy-now flavors.
// We treat "active" as creator != 0x0; the home-grid scanner records
// the raw `type_` so future code can filter without re-scanning.
const LISTING_TYPE_NOT_CONFIGURED = 0

// Universal Deployer event — emitted on each new ERC721TL / ERC1155TL
// proxy. `sender` is indexed → cheap server-side filter for "this
// artist's deployed contracts" (typically 0–3 logs per artist).
const contractDeployedEvent = parseAbiItem(
  "event ContractDeployed(address indexed sender, address indexed deployedContract, address indexed implementation, string cType, string version)",
)
// ERC-721 Transfer — used to enumerate mints on each TL contract by
// scanning Transfer(from=0x0). Matches the same shape used by the SR
// V2 / Foundation collection-factory flows.
const erc721TransferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
const auctionSettledEvent = parseAbiItem(
  "event AuctionSettled(address indexed sender, address indexed nftAddress, uint256 indexed tokenId, (uint8,bool,address,address,address,uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256) listing)",
)
const buyNowFulfilledEvent = parseAbiItem(
  "event BuyNowFulfilled(address indexed sender, address indexed nftAddress, uint256 indexed tokenId, address recipient, (uint8,bool,address,address,address,uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256) listing)",
)
// Bid history: indexed (sender, nftAddress, tokenId). The full Listing
// struct rides on each event so we can filter to the current listing.id
// in-memory after the scan (TL re-uses (contract, tokenId) when an
// artist delists + relists).
const auctionBidEvent = parseAbiItem(
  "event AuctionBid(address indexed sender, address indexed nftAddress, uint256 indexed tokenId, (uint8,bool,address,address,address,uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256) listing)",
)

// Block-range chunk for indexed-arg log scans.
const BLOCK_RANGE = 2_000_000n

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: getMainnetTransport("transient", { batch: true }),
  })
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
 * Bid history for the CURRENT listing on (contract, tokenId). Mirrors
 * Foundation's lazy pattern (see `getFoundationBidHistory`).
 *
 * Each AuctionBid event carries the full Listing struct (including
 * `id`); we filter to bids where listing.id matches the current
 * listing's id so prior listings on the same token don't leak in.
 */
async function getTransientBidHistory(
  client: ReturnType<typeof createPublicClient>,
  contract: Address,
  tokenId: string,
  currentListingId: bigint,
): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">>> {
  const listingIdStr = currentListingId.toString()
  const freshness = await readTransientBidHistoryFreshness(
    contract,
    tokenId,
    listingIdStr,
  )
  if (freshness && isFresh(freshness, LAZY_TTL.transientBids)) {
    const cached = await readTransientBidHistory(contract, tokenId, listingIdStr)
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
        address: TL_AH,
        event: auctionBidEvent,
        args: { nftAddress: contract, tokenId: BigInt(tokenId) },
        fromBlock: from,
        toBlock: to,
      }),
    TL_AUCTION_HOUSE_DEPLOY_BLOCK,
    latest,
  )

  if (logs.length === 0) return []

  // Decode + filter to current listing.id. Listing tuple is anonymous
  // in the parseAbiItem signature → array decoding (positional).
  type ListingArray = readonly [
    number, boolean, Address, Address, Address,
    bigint, bigint, bigint, bigint, bigint,
    Address, Address, bigint, bigint,
  ]
  type Decoded = {
    bidder: Address
    amount: bigint
    txHash: `0x${string}`
    logIndex: number
    blockNumber: bigint
    blockTime: number
    listingId: bigint
  }
  const decodedRaw: Omit<Decoded, "blockTime">[] = []
  for (const l of logs) {
    if (l.blockNumber === null || l.transactionHash === null) continue
    if (l.logIndex === null) continue
    const args = l.args as { sender?: Address; listing?: ListingArray }
    const tuple = args.listing
    if (!tuple) continue
    const [, , , , currency, , , , , , , highestBidder, highestBid, id] = tuple
    if (currency.toLowerCase() !== ETH_CURRENCY) continue
    if (id !== currentListingId) continue // only current listing's bids
    decodedRaw.push({
      bidder: highestBidder,
      amount: highestBid,
      txHash: l.transactionHash,
      logIndex: l.logIndex,
      blockNumber: l.blockNumber,
      listingId: id,
    })
  }

  // Resolve unique block timestamps in parallel.
  const uniqueBlocks = Array.from(new Set(decodedRaw.map((d) => d.blockNumber)))
  const blockTimes = new Map<bigint, number>()
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      const block = await client.getBlock({ blockNumber: bn }).catch(() => null)
      blockTimes.set(bn, block ? Number(block.timestamp) : 0)
    }),
  )
  const decoded: Decoded[] = decodedRaw.map((d) => ({
    ...d,
    blockTime: blockTimes.get(d.blockNumber) ?? 0,
  }))

  writeTransientBidHistory(
    contract,
    tokenId,
    decoded.map((d) => ({
      txHash: d.txHash,
      logIndex: d.logIndex,
      listingId: d.listingId.toString(),
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

// `getListing(nftAddress, tokenId)` returns the Listing struct. Because
// the ABI tuple has named components, viem decodes it as an object
// (NOT a positional array) — so we read by field name rather than
// destructure. Same convention applies in the scanner where event
// payloads include this struct.
type Listing = {
  type_: number
  zeroProtocolFee: boolean
  seller: Address
  payoutReceiver: Address
  currencyAddress: Address
  openTime: bigint
  reservePrice: bigint
  buyNowPrice: bigint
  startTime: bigint
  duration: bigint
  recipient: Address
  highestBidder: Address
  highestBid: bigint
  id: bigint
}

/**
 * Transient Labs platform adapter.
 *
 * Coverage:
 *   - All `ERC721TL` per-artist contracts (deployed via TL Universal
 *     Deployer as ERC-1167 minimal proxies). The adapter is contract-
 *     agnostic: `getActiveAuctionForToken` / `getLastSale` work for any
 *     ERC-721 with a TL Auction House listing.
 *
 * Custody pattern (DIFFERENT from SR Bazaar):
 *   - The Auction House calls `transferFrom` when a listing is
 *     configured, so `ownerOf` returns the Auction House address while
 *     a listing is live. This means owner-based dispatch in
 *     `auctions.ts` works cleanly — no fall-through hack needed.
 *
 * Discovery strategy (cost-bounded by indexed-arg event filters):
 *   - Artist mints: NOT YET. Requires enumerating per-artist contracts
 *     via the Universal Deployer's deployment events. Returns [] for
 *     now; tracked as a follow-up.
 *   - Last sale: AuctionSettled + BuyNowFulfilled, both indexed by
 *     `nftAddress` + `tokenId`. Take the most-recent of either.
 *   - Collector tokens: NOT YET. Same enumeration constraint.
 *   - Active auctions / token state: incremental scan of
 *     ListingConfigured / AuctionBid / AuctionSettled /
 *     BuyNowFulfilled / ListingCanceled events on the Auction House
 *     populates `lazy_tl_active_auctions`; `getActiveAuctionForToken`
 *     reads `getListing(nftAddress, tokenId)` directly for the live
 *     state on demand.
 *
 * Bid currency: only ETH listings (currencyAddress = 0x0) surface in
 * our UI. ERC-20 listings exist on TL but are out of scope for the MVP.
 */
export const transientAdapter: PlatformAdapter = {
  id: "transient",
  displayName: "Transient",

  /**
   * Tokens an artist has minted on Transient Labs. Lazy pattern matches
   * Foundation / SR V2:
   *
   *   1. Read `lazy_tl_artist_tokens` (status row + rows). If fresh
   *      per LAZY_TTL.transientArtistTokens (30d), return cached.
   *   2. Otherwise: scan Universal Deployer's `ContractDeployed` event
   *      filtered by indexed `sender = artist` to find every TL
   *      proxy this artist has deployed. Filter to ERC721TL only
   *      (ERC1155 deferred — its enumeration semantics differ).
   *   3. For each contract, scan `Transfer(from=0x0)` to collect all
   *      mints. Persist via `writeTransientArtistTokens` and return.
   *
   * Cost shape per cold visit: ~1 indexed-arg scan on the deployer
   * (cheap; usually 0–3 results) + 1 Transfer-from-zero scan per
   * deployed contract (also cheap; per-token-mint event volume on a
   * typical artist contract is small).
   */
  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    const cached = await readTransientArtistTokens(artist)
    if (cached && isFresh(cached.lastIndexedAt, LAZY_TTL.transientArtistTokens)) {
      return cached.tokens.map((t) => ({
        platform: "transient",
        contract: t.contract as Address,
        tokenId: t.tokenId,
        blockNumber: t.blockNumber,
        logIndex: t.logIndex,
        collectionName: null,
      }))
    }

    const client = getClient()
    const latest = await client.getBlockNumber()

    // Step 1 — find every TL contract this artist has deployed.
    const deployLogs = await paginatedIndexedScan(
      (from, to) =>
        client.getLogs({
          address: TL_DEPLOYER,
          event: contractDeployedEvent,
          args: { sender: artist },
          fromBlock: from,
          toBlock: to,
        }),
      TL_DEPLOYER_DEPLOY_BLOCK,
      latest,
    )

    // Filter to ERC721TL contracts. ERC1155 mints have different
    // enumeration semantics (TransferSingle/TransferBatch) and are
    // out of scope for this pass — flagged as a follow-up.
    const contracts: Address[] = []
    for (const log of deployLogs) {
      const args = log.args as { deployedContract?: Address; cType?: string }
      if (!args.deployedContract || !args.cType) continue
      // TL's cType strings include "ERC721TL", "ERC721TLM" (multi-tag),
      // "ERC721TLCore", etc. — match prefix to catch all variants.
      if (!args.cType.startsWith("ERC721")) continue
      contracts.push(args.deployedContract)
    }

    // Step 2 — for each contract, scan Transfer-from-zero (all mints).
    // We don't filter by `to` because TL primary sales mint directly
    // to the buyer; the artist's gallery should still surface those
    // pieces (the artist authored them even if the mint went elsewhere).
    type Ref = {
      contract: Address
      tokenId: string
      blockNumber: bigint
      logIndex: number
    }
    const refs: Ref[] = []
    for (const contract of contracts) {
      const mintLogs = await paginatedIndexedScan(
        (from, to) =>
          client.getLogs({
            address: contract,
            event: erc721TransferEvent,
            args: { from: ZERO_ADDRESS as Address },
            fromBlock: from,
            toBlock: to,
          }),
        TL_DEPLOYER_DEPLOY_BLOCK,
        latest,
      )
      for (const l of mintLogs) {
        if (l.blockNumber === null || l.logIndex === null) continue
        const args = l.args as { tokenId?: bigint }
        if (args.tokenId === undefined) continue
        refs.push({
          contract,
          tokenId: args.tokenId.toString(),
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
        })
      }
    }

    // Persist so subsequent visits within the 30d TTL skip the scan.
    // `writeTransientArtistTokens` writes both the rows AND the
    // status row, so an artist with zero TL contracts still gets
    // marked as indexed (returning [] without re-scanning).
    writeTransientArtistTokens(artist, refs)

    return refs.map((r) => ({
      platform: "transient",
      contract: r.contract,
      tokenId: r.tokenId,
      blockNumber: r.blockNumber,
      logIndex: r.logIndex,
      collectionName: null,
    }))
  },

  async discoverCollectorTokens(): Promise<CollectorTokenRef[]> {
    // Same constraint as artist tokens — defer to follow-up.
    return []
  },

  async getLastSale(
    contract: Address,
    tokenId: string,
  ): Promise<AdapterLastSale | null> {
    const cached = await readTransientSale(contract, tokenId)
    if (cached && isFresh(cached.lastIndexedAt, LAZY_TTL.transientSale)) {
      return {
        platform: "transient",
        priceWei: cached.priceWei,
        blockTime: cached.blockTime,
        source: cached.source,
        txHash: cached.txHash,
      }
    }

    const client = getClient()
    const latest = await client.getBlockNumber()

    // Both AuctionSettled and BuyNowFulfilled are indexed by
    // (nftAddress, tokenId); fetch in parallel and pick the most
    // recent across the two streams.
    const [settled, buyNow] = await Promise.all([
      paginatedIndexedScan(
        (from, to) =>
          client.getLogs({
            address: TL_AH,
            event: auctionSettledEvent,
            args: { nftAddress: contract, tokenId: BigInt(tokenId) },
            fromBlock: from,
            toBlock: to,
          }),
        TL_AUCTION_HOUSE_DEPLOY_BLOCK,
        latest,
      ),
      paginatedIndexedScan(
        (from, to) =>
          client.getLogs({
            address: TL_AH,
            event: buyNowFulfilledEvent,
            args: { nftAddress: contract, tokenId: BigInt(tokenId) },
            fromBlock: from,
            toBlock: to,
          }),
        TL_AUCTION_HOUSE_DEPLOY_BLOCK,
        latest,
      ),
    ])

    type Cand = {
      blockNumber: bigint
      txHash: `0x${string}`
      currency: Address
      amount: bigint
      source: "auction" | "buyNow"
    }
    const candidates: Cand[] = []
    for (const l of settled) {
      const args = l.args as {
        listing?: readonly [number, boolean, Address, Address, Address, bigint, bigint, bigint, bigint, bigint, Address, Address, bigint, bigint]
      }
      const tuple = args.listing
      if (!tuple || l.blockNumber === null || l.transactionHash === null) continue
      const [, , , , currency, , , , , , , , highestBid] = tuple
      candidates.push({
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        currency,
        amount: highestBid,
        source: "auction",
      })
    }
    for (const l of buyNow) {
      const args = l.args as {
        listing?: readonly [number, boolean, Address, Address, Address, bigint, bigint, bigint, bigint, bigint, Address, Address, bigint, bigint]
      }
      const tuple = args.listing
      if (!tuple || l.blockNumber === null || l.transactionHash === null) continue
      const [, , , , currency, , , buyNowPrice] = tuple
      candidates.push({
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        currency,
        amount: buyNowPrice,
        source: "buyNow",
      })
    }

    // Skip ERC-20 settlements; we don't surface non-ETH prices today.
    const eth = candidates.filter(
      (c) => c.currency.toLowerCase() === ETH_CURRENCY,
    )
    if (eth.length === 0) return null
    eth.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1))
    const pick = eth[0]
    if (pick.amount === 0n) return null

    const block = await client
      .getBlock({ blockNumber: pick.blockNumber })
      .catch(() => null)
    if (!block) return null
    const blockTime = Number(block.timestamp)

    writeTransientSale(contract, tokenId, {
      priceWei: pick.amount,
      blockTime,
      source: pick.source,
      txHash: pick.txHash,
    })

    return {
      platform: "transient",
      priceWei: pick.amount,
      blockTime,
      source: pick.source,
      txHash: pick.txHash,
    }
  },

  async getActiveAuctionForToken(
    contract: Address,
    tokenId: string,
  ): Promise<AuctionState | null> {
    const client = getClient()

    // Single read returns the entire Listing struct + the contract's
    // computed minimum next bid. `getRoyalty` is a third call but
    // gives us the actual royalty bps for the FeesBreakdown.
    const [listing, nextBid, protocolFeeBps] = await Promise.all([
      client
        .readContract({
          address: TL_AH,
          abi: transientAuctionHouseAbi,
          functionName: "getListing",
          args: [contract, BigInt(tokenId)],
        })
        .catch(() => null),
      client
        .readContract({
          address: TL_AH,
          abi: transientAuctionHouseAbi,
          functionName: "getNextBid",
          args: [contract, BigInt(tokenId)],
        })
        .catch(() => null),
      client
        .readContract({
          address: TL_AH,
          abi: transientAuctionHouseAbi,
          functionName: "protocolFeeBps",
        })
        .catch(() => 0n),
    ])

    if (!listing) return null
    const l = listing as unknown as Listing
    const {
      type_,
      seller,
      currencyAddress,
      reservePrice,
      startTime,
      duration,
      highestBidder,
      highestBid,
      id,
    } = l

    if (type_ === LISTING_TYPE_NOT_CONFIGURED) return null
    if (seller === ZERO_ADDRESS) return null
    if (currencyAddress.toLowerCase() !== ETH_CURRENCY) return null

    const awaitingFirstBid = highestBidder === ZERO_ADDRESS || highestBid === 0n
    // Once the first bid lands, TL sets `startTime` to that block's
    // timestamp; endTime = startTime + duration. Pre-bid the timer
    // hasn't started — treat as 0 (sorts to the tail of home grid).
    const endTime = awaitingFirstBid ? 0n : startTime + duration
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    const awaitingSettlement =
      !awaitingFirstBid && endTime > 0n && endTime <= nowSec

    // Display "current" amount: post-bid show the high bid, pre-bid
    // show the reserve.
    const amount = awaitingFirstBid ? reservePrice : highestBid
    // Pre-bid: TL's `getNextBid` returns a sentinel `1` (the contract
    // checks `bid >= reservePrice` separately, so any wei > 0 satisfies
    // the next-bid invariant — the reserve is the real floor). Use
    // reservePrice as the displayed minimum so the UI matches what
    // a successful first bid actually requires.
    // Post-bid: trust the contract-provided value (currentBid scaled
    // up by BID_INCREASE_BPS).
    const minBidWei = awaitingFirstBid
      ? reservePrice
      : (nextBid as bigint | null) ?? highestBid

    // Bid history for the current listing.id (skips bids from prior
    // listings on the same token). Same lazy + RPC pattern as Foundation.
    const rawBids = await getTransientBidHistory(client, contract, tokenId, id)
    const addressesToResolve: string[] = [seller]
    if (highestBidder !== ZERO_ADDRESS) addressesToResolve.push(highestBidder)
    for (const b of rawBids) addressesToResolve.push(b.bidder)
    const names = await resolveDisplayNames(addressesToResolve)
    const lookup = (a: Address) => names.get(a.toLowerCase()) ?? a

    // Fee structure: TL takes a flat `protocolFeeBps` of the bid (no
    // buyer's premium — verified by fork test). Royalty comes from
    // ERC-2981 via the NFT contract or TL's RoyaltyLookup; for the
    // fees panel we surface the protocol fee as "Transient fee" and
    // leave royalty at 0% pending a per-token RoyaltyLookup read
    // (deferred — same call adds RPC cost on every render and the
    // typical TL royalty is 10%; `getRoyalty` on the Auction House
    // gives an exact value when needed).
    const protoBps = Number(protocolFeeBps)
    const fees: AuctionFees = {
      platformLabel: "Transient Labs",
      protocolFeeBps: protoBps,
      creatorRoyaltyBps: 0,
      sellerBps: Math.max(0, 10000 - protoBps),
    }

    return {
      source: "transient",
      marketAddress: TL_AH,
      auctionId: id.toString(),
      nftContract: contract,
      tokenId,
      seller,
      sellerDisplay: lookup(seller),
      amount,
      bidder: highestBidder,
      bidderDisplay: highestBidder === ZERO_ADDRESS ? "" : lookup(highestBidder),
      endTime,
      duration,
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

  async discoverArtistAuctions(artist: Address): Promise<void> {
    await discoverTransientArtistAuctions(artist)
  },

  async getActiveAuctions(limit: number): Promise<ActiveAuctionSummary[]> {
    // Pure table read — no RPC in the home-grid request path. The
    // per-artist scanner runs from artist-page loads via
    // `discoverArtistAuctions`, populating the table for whoever's
    // been visited. Reads JOIN the per-artist status table with a
    // 24h freshness filter so unvisited artists drop out.
    // Over-read + filter to artist-sellers (seller == tokenCreator)
    // so the home grid surfaces primary-market work only.
    const rows = await readTransientActiveAuctions(limit * 4)
    return rows
      .filter(
        (r) =>
          r.creator !== null &&
          r.creator.toLowerCase() === r.seller.toLowerCase(),
      )
      .slice(0, limit)
      .map((r) => ({
        platform: "transient",
        contract: r.contract as Address,
        tokenId: r.tokenId,
        seller: r.seller as Address,
        reserveWei: r.reserveWei,
        currentBidWei: r.currentBidWei,
        currentBidder: (r.currentBidder ?? null) as Address | null,
        endTime: r.endTime,
        sourceContract: TL_AH,
      }))
  },
}
