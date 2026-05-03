/**
 * Auction state lookups via direct RPC.
 *
 * Source-agnostic: a single token can have an active auction on either the
 * Foundation NFTMarket OR a sovereign auction house. Since the NFT is escrowed in
 * the auction contract, only one source can be active at a time. We probe both
 * in parallel and return whichever has the auction.
 */
import { unstable_cache } from "next/cache"
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { erc721Abi, nftMarketAbi, sovereignAuctionHouseAbi, sovereignAuctionHouseFactoryAbi } from "@pin/abi"
import { pgCache } from "./pg-cache"
import { getActiveAuctionCountFromIndexer } from "./indexer-queries"
import {
  readFoundationBidHistory,
  readFoundationBidHistoryFreshness,
  writeFoundationBidHistory,
  readPndBidHistory,
  readPndBidHistoryFreshness,
  writePndBidHistory,
  readScanCursor,
  writeScanCursor,
  LAZY_TTL,
  isFresh,
} from "./lazy-index"
import {
  NFT_MARKET,
  MAINNET_CHAIN_ID,
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  TL_AUCTION_HOUSE,
  getAddressOrNull,
} from "@pin/addresses"
import { resolveDisplayNames } from "./artist-queries"

const FND_MARKET = NFT_MARKET[MAINNET_CHAIN_ID]
const SOVEREIGN_FACTORY = getAddressOrNull(SOVEREIGN_AUCTION_HOUSE_FACTORY, MAINNET_CHAIN_ID)
const TL_AH = TL_AUCTION_HOUSE[MAINNET_CHAIN_ID]
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * Normalized fee breakdown for an auction. Same shape regardless of source.
 */
export type AuctionFees = {
  /** Human label for the fee taker, e.g. "Foundation" or "PND". */
  platformLabel: string
  /** Basis points (1% = 100). Computed from the contract's fee call at the current price. */
  protocolFeeBps: number
  /** Basis points of creator royalty applied to this token (0 if none/primary). */
  creatorRoyaltyBps: number
  /** Basis points the seller nets after fees + royalty. */
  sellerBps: number
}

export type BidHistoryEntry = {
  bidder: Address
  bidderDisplay: string
  amount: bigint
  blockTime: number
  txHash: string
}

export type AuctionSource = "foundation" | "sovereign" | "superrareV2" | "transient"

/**
 * Shared shape for both Foundation and artist-owned auctions. The `source` discriminator
 * tells the panel which contract + ABI to dispatch write calls against; the
 * `marketAddress` is the contract that holds the auction.
 */
export type AuctionState = {
  source: AuctionSource
  /** Contract address that holds this auction (for write calls). */
  marketAddress: Address
  auctionId: string
  nftContract: Address
  tokenId: string
  seller: Address
  sellerDisplay: string
  /** Reserve price before any bids; current high bid after. */
  amount: bigint
  /** Zero address until the first bid is placed. */
  bidder: Address
  /** ENS or truncated display for the current bidder. Empty when no bids. */
  bidderDisplay: string
  /** Zero until the first bid is placed; then now+duration, extended by late bids. */
  endTime: bigint
  duration: bigint
  /** Canonical minimum next-bid amount, sourced from the contract. */
  minBidWei: bigint
  /** Derived flag: auction created but no bids yet (timer not started). */
  awaitingFirstBid: boolean
  /** Derived flag: endTime has passed but tx hasn't been finalized. */
  awaitingSettlement: boolean
  /** Fee breakdown at the current effective price. Null if fee call failed. */
  fees: AuctionFees | null
  /** Newest-first bid history with ENS-resolved display names. */
  bidHistory: BidHistoryEntry[]
}

/** @deprecated Use AuctionState. Kept temporarily for callers in flight. */
export type FoundationAuctionState = AuctionState & { source: "foundation" }

const fndBidPlacedEvent = parseAbiItem(
  "event ReserveAuctionBidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 endTime)",
)
const sovereignBidPlacedEvent = parseAbiItem(
  "event AuctionBid(uint256 indexed auctionId, address indexed bidder, uint256 amount, bool firstBid, bool extended)",
)

/** NFTMarket proxy was deployed Dec 2021. Anything earlier can't have bids. */
const FND_MARKET_DEPLOY_BLOCK = 13_840_000n
/** SovereignAuctionHouseFactory deploy block. Verified: `cast code`
 *  returns 0x at 24,973,293 and real bytecode at 24,973,294. Used as a
 *  lower bound for log scans on the factory and any houses it created —
 *  earlier scans are wasted, later misses houses. */
const SOVEREIGN_FACTORY_DEPLOY_BLOCK = 24_973_294n

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ?? "https://eth.llamarpc.com",
    ),
  })
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Auction state for a token, dispatching to whichever source (Foundation
 * NFTMarket or sovereign artist house) actually escrows it.
 *
 * Two optimizations vs. the naive parallel-probe:
 *
 *  1. Single discriminator. Read `ownerOf(tokenId)` once and branch on the
 *     result, instead of probing both sources speculatively. Cuts ~half the
 *     RPC reads per render — the dominant cost driver before caching.
 *
 *  2. 30s response cache via `unstable_cache`. Auction state changes only
 *     on bid / settle, both of which require an on-chain tx — so a brief
 *     cache window just collapses bot/refresh traffic. Bigints are
 *     stringified at the cache boundary because the cache layer
 *     JSON-serializes (same pattern as `getLastSalePriceForToken`).
 *
 *  Tag: `auction:<lower-contract>:<tokenId>` for surgical revalidation
 *  after a bid/settle write succeeds in the UI.
 */
/**
 * Build a per-token tag for `revalidateTag`. Keep this in sync with the
 * cache wrapper below — the `/api/auction/revalidate` route calls
 * `revalidateTag(auctionTokenTag(...))` after a bid/settle tx confirms.
 */
export function auctionTokenTag(nftContract: string, tokenId: string): string {
  return `auction:${nftContract.toLowerCase()}:${tokenId}`
}

export async function getAuctionForToken(
  nftContract: string,
  tokenId: string,
): Promise<AuctionState | null> {
  const lower = nftContract.toLowerCase()
  // L1 (in-process) wraps L2 (Postgres) wraps the actual fetcher. Same
  // (contract, tokenId) baked into both layers' keys so revalidation in
  // either layer hits the right entry. `auctionTokenTag` is exposed for
  // `/api/auction/revalidate` to flush both L1 (via revalidateTag) and
  // L2 (via pgCacheInvalidate) after a bid/settle/cancel/update.
  const cached = unstable_cache(
    (c: string, t: string) =>
      pgCache<SerializedAuctionState | null>(
        auctionTokenTag(c, t),
        30,
        () => fetchAuctionForToken(c, t),
      ),
    ["auction-for-token-v1", lower, tokenId],
    { revalidate: 30, tags: [auctionTokenTag(lower, tokenId)] },
  )
  const result = await cached(lower, tokenId)
  return result ? hydrateAuctionState(result) : null
}

async function fetchAuctionForToken(
  nftContract: string,
  tokenId: string,
): Promise<SerializedAuctionState | null> {
  const client = getClient()
  const contract = nftContract as Address
  const tokenIdBig = BigInt(tokenId)

  // Discriminate once. Only one source can be active at a time because the
  // NFT is escrowed in a specific contract during an auction.
  let owner: Address
  try {
    owner = await client.readContract({
      address: contract,
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [tokenIdBig],
    })
  } catch {
    // Token doesn't exist or RPC failed — either way, no auction to show.
    return null
  }

  let state: AuctionState | null = null
  if (owner.toLowerCase() === FND_MARKET.toLowerCase()) {
    state = await getFoundationAuction(nftContract, tokenId)
  } else if (owner.toLowerCase() === TL_AH.toLowerCase()) {
    // TL Auction House custodies the NFT during a listing, so
    // ownerOf points here whenever there's a live TL auction. Same
    // pattern as Foundation — clean owner-based dispatch.
    const { transientAdapter } = await import("./platforms/transient")
    state = (await transientAdapter.getActiveAuctionForToken?.(
      contract,
      tokenId,
    )) ?? null
  } else if (SOVEREIGN_FACTORY) {
    let isHouse = false
    try {
      isHouse = await client.readContract({
        address: SOVEREIGN_FACTORY,
        abi: sovereignAuctionHouseFactoryAbi,
        functionName: "isHouse",
        args: [owner],
      })
    } catch {
      // Treat factory failure as "not a house" — UI will show no auction
      // rather than crash. The 30s cache means we'll retry shortly anyway.
    }
    if (isHouse) {
      state = await readSovereignAuction(client, owner, contract, tokenIdBig)
    }
  }

  // SR Bazaar doesn't custody NFTs during an auction — the seller keeps
  // ownerOf and Bazaar records the auction in its tokenAuctions mapping.
  // Owner-based routing therefore can't surface SR auctions; we fall
  // through and ask the adapter directly. The check is a single eth_call
  // against `tokenAuctions(contract, tokenId)` and returns null when no
  // active SR auction exists. Bazaar covers both the V2 shared NFT and
  // every SuperRare Space (per-Space ERC-721 contracts), so we no longer
  // gate this on the V2-NFT address — any contract with a Bazaar entry
  // gets surfaced.
  if (!state) {
    const { superrareV2Adapter } = await import("./platforms/superrareV2")
    state = (await superrareV2Adapter.getActiveAuctionForToken?.(
      contract,
      tokenId,
    )) ?? null
  }

  return state ? serializeAuctionState(state) : null
}

// Bigints don't survive JSON serialization, so we stringify them at the cache
// boundary. Hydrate back to AuctionState before returning to callers so the
// rest of the app (panel, bid form) is unaware of the cache layer.
type SerializedBidHistoryEntry = Omit<BidHistoryEntry, "amount"> & {
  amount: string
}
type SerializedAuctionState = Omit<
  AuctionState,
  "amount" | "endTime" | "duration" | "minBidWei" | "bidHistory"
> & {
  amount: string
  endTime: string
  duration: string
  minBidWei: string
  bidHistory: SerializedBidHistoryEntry[]
}

function serializeAuctionState(s: AuctionState): SerializedAuctionState {
  return {
    ...s,
    amount: s.amount.toString(),
    endTime: s.endTime.toString(),
    duration: s.duration.toString(),
    minBidWei: s.minBidWei.toString(),
    bidHistory: s.bidHistory.map((b) => ({ ...b, amount: b.amount.toString() })),
  }
}

function hydrateAuctionState(s: SerializedAuctionState): AuctionState {
  return {
    ...s,
    amount: BigInt(s.amount),
    endTime: BigInt(s.endTime),
    duration: BigInt(s.duration),
    minBidWei: BigInt(s.minBidWei),
    bidHistory: s.bidHistory.map((b) => ({ ...b, amount: BigInt(b.amount) })),
  }
}

// ─── Foundation source ──────────────────────────────────────────────────────

export async function getFoundationAuction(
  nftContract: string,
  tokenId: string,
): Promise<AuctionState | null> {
  const client = getClient()
  const contract = nftContract as Address

  let auctionId: bigint
  try {
    auctionId = await client.readContract({
      address: FND_MARKET,
      abi: nftMarketAbi,
      functionName: "getReserveAuctionIdFor",
      args: [contract, BigInt(tokenId)],
    })
  } catch {
    return null
  }

  if (auctionId === 0n) return null

  let auction: {
    nftContract: Address
    tokenId: bigint
    seller: Address
    duration: bigint
    extensionDuration: bigint
    endTime: bigint
    bidder: Address
    amount: bigint
  }
  try {
    auction = await client.readContract({
      address: FND_MARKET,
      abi: nftMarketAbi,
      functionName: "getReserveAuction",
      args: [auctionId],
    })
  } catch {
    return null
  }

  if (auction.seller === ZERO_ADDRESS) return null

  let minBidWei: bigint
  try {
    minBidWei = await client.readContract({
      address: FND_MARKET,
      abi: nftMarketAbi,
      functionName: "getMinBidAmount",
      args: [auctionId],
    })
  } catch {
    minBidWei = auction.amount
  }

  const pricedAt = auction.amount > 0n ? auction.amount : minBidWei

  const [fees, rawHistory] = await Promise.all([
    getFoundationFees(client, auction.nftContract, auction.tokenId, pricedAt),
    getFoundationBidHistory(
      client,
      auctionId,
      auction.bidder === ZERO_ADDRESS
        ? null
        : { bidder: auction.bidder, amount: auction.amount },
    ),
  ])

  const awaitingFirstBid =
    auction.endTime === 0n || auction.bidder === ZERO_ADDRESS
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const awaitingSettlement =
    !awaitingFirstBid && auction.endTime > 0n && auction.endTime <= nowSec

  const addressesToResolve: string[] = [auction.seller]
  if (auction.bidder !== ZERO_ADDRESS) addressesToResolve.push(auction.bidder)
  for (const b of rawHistory) addressesToResolve.push(b.bidder)
  const names = await resolveDisplayNames(addressesToResolve)
  const lookup = (a: Address) => names.get(a.toLowerCase()) ?? a

  return {
    source: "foundation",
    marketAddress: FND_MARKET,
    auctionId: auctionId.toString(),
    nftContract: auction.nftContract,
    tokenId: auction.tokenId.toString(),
    seller: auction.seller,
    sellerDisplay: lookup(auction.seller),
    amount: auction.amount === 0n ? minBidWei : auction.amount,
    bidder: auction.bidder,
    bidderDisplay:
      auction.bidder === ZERO_ADDRESS ? "" : lookup(auction.bidder),
    endTime: auction.endTime,
    duration: auction.duration,
    minBidWei,
    awaitingFirstBid,
    awaitingSettlement,
    fees,
    bidHistory: rawHistory.map((b) => ({ ...b, bidderDisplay: lookup(b.bidder) })),
  }
}

async function getFoundationBidHistory(
  client: ReturnType<typeof createPublicClient>,
  auctionId: bigint,
  expectedTop: { bidder: Address; amount: bigint } | null,
): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">>> {
  // Lazy index read: if recent rows exist, return them and skip the RPC
  // scan + per-block timestamp round-trips entirely. Skip cache when its
  // top row doesn't match the on-chain leader — `last_indexed_at` only
  // moves on writes, so a fresh cache can still be missing a bid placed
  // since the last scan. The chain-side leader is the ground truth.
  const auctionIdStr = auctionId.toString()
  const freshness = await readFoundationBidHistoryFreshness(auctionIdStr)
  if (freshness && isFresh(freshness, LAZY_TTL.foundationBids)) {
    const cached = await readFoundationBidHistory(auctionIdStr)
    if (cached && cacheCoversTop(cached, expectedTop)) {
      return cached.map((b) => ({
        bidder: b.bidder as Address,
        amount: b.amount,
        blockTime: b.blockTime,
        txHash: b.txHash as `0x${string}`,
      }))
    }
  }

  // Pre-bid short-circuit: no on-chain leader means there's nothing to
  // find in logs. Saves an `eth_getLogs` per cold view of an auction
  // that hasn't received its first bid yet.
  if (!expectedTop) {
    const cached = await readFoundationBidHistory(auctionIdStr)
    return (cached ?? []).map((b) => ({
      bidder: b.bidder as Address,
      amount: b.amount,
      blockTime: b.blockTime,
      txHash: b.txHash as `0x${string}`,
    }))
  }

  // Cursor-bounded incremental scan. Drops steady-state getLogs range
  // from ~14M blocks (deploy → head) to whatever accumulated since
  // this auction was last scanned. The cursor is advanced after every
  // successful scan — even with 0 matches — so a quiet auction
  // doesn't keep re-paying for the deploy-to-head range.
  const scanKey = `fnd_bids:${auctionIdStr}`
  const cursor = await readScanCursor(scanKey)
  const fromBlock = cursor ? cursor.lastBlock + 1n : FND_MARKET_DEPLOY_BLOCK
  const latest = await client.getBlockNumber().catch(() => null)
  if (latest === null) {
    // Couldn't read head; fall back to whatever's cached. Don't move
    // the cursor either (we'd lose any blocks scanned next time).
    const cached = await readFoundationBidHistory(auctionIdStr)
    return (cached ?? []).map((b) => ({
      bidder: b.bidder as Address,
      amount: b.amount,
      blockTime: b.blockTime,
      txHash: b.txHash as `0x${string}`,
    }))
  }

  const logs =
    fromBlock > latest
      ? []
      : await client
          .getLogs({
            address: FND_MARKET,
            event: fndBidPlacedEvent,
            args: { auctionId },
            fromBlock,
            toBlock: latest,
          })
          .catch(() => [])

  const enriched = await enrichBidLogs(client, logs, "amount")

  // Fire-and-forget UPSERT. We have the txHash from each log; logIndex
  // isn't on the enriched type so we re-derive it from the raw logs.
  if (enriched.length > 0) {
    const logsByTx = new Map<string, number>()
    for (const l of logs) {
      if (l.transactionHash && typeof l.logIndex === "number") {
        logsByTx.set(l.transactionHash, l.logIndex)
      }
    }
    const blocksByTx = new Map<string, bigint>()
    for (const l of logs) {
      if (l.transactionHash && l.blockNumber !== null) {
        blocksByTx.set(l.transactionHash, l.blockNumber)
      }
    }
    writeFoundationBidHistory(
      auctionIdStr,
      enriched.map((b) => ({
        txHash: b.txHash,
        logIndex: logsByTx.get(b.txHash) ?? 0,
        bidder: b.bidder,
        amount: b.amount,
        blockTime: b.blockTime,
        blockNumber: blocksByTx.get(b.txHash) ?? 0n,
      })),
    )
  }
  await writeScanCursor(scanKey, latest)

  // Merge cached + just-scanned. The scan is now incremental so it
  // can't return full history on its own. Dedupe by txHash; sort
  // newest-first by amount (Foundation bids are monotonically
  // increasing, so amount-DESC matches block-DESC).
  const cached = (await readFoundationBidHistory(auctionIdStr)) ?? []
  return mergeBidHistory(cached, enriched)
}

async function getFoundationFees(
  client: ReturnType<typeof createPublicClient>,
  nftContract: Address,
  tokenId: bigint,
  price: bigint,
): Promise<AuctionFees | null> {
  if (price === 0n) return null
  try {
    const [totalFees, creatorRev, , , sellerRev] = await client.readContract({
      address: FND_MARKET,
      abi: nftMarketAbi,
      functionName: "getFeesAndRecipients",
      args: [nftContract, tokenId, price],
    })

    return {
      platformLabel: "Foundation",
      protocolFeeBps: weiToBps(totalFees, price),
      creatorRoyaltyBps: weiToBps(creatorRev, price),
      sellerBps: weiToBps(sellerRev, price),
    }
  } catch {
    return null
  }
}

// ─── Artist-Owned source ─────────────────────────────────────────────────────────────

/**
 * Build the full auction state given the house address that holds it.
 * Exposed because callers that already know the house (e.g. an artist gallery
 * page that fetched it once) can skip the ownerOf+isHouse round-trip.
 */
export async function getSovereignAuctionByHouse(
  houseAddress: Address,
  nftContract: string,
  tokenId: string,
): Promise<AuctionState | null> {
  const client = getClient()
  return readSovereignAuction(client, houseAddress, nftContract as Address, BigInt(tokenId))
}

/**
 * Count active auctions on an artist's sovereign house. "Active" = registered
 * in storage (tokenOwner != 0); covers both pre-bid and post-bid live
 * auctions. Settled and cancelled auctions are deleted from storage so they
 * don't count.
 *
 * Returns null when the artist has no sovereign house or the factory isn't
 * configured for this chain. Returns 0 when they have a house but no live
 * auctions on it.
 *
 * Strategy: scan the house's AuctionCreated logs to learn the auctionIds that
 * ever existed, then read each auction's current state to filter to live
 * ones. For a single artist's house this is a small log range and a small
 * batch of reads — fine inline; if it grows beyond ~hundreds of auctions
 * we'd want to switch to multicall or a derived counter on-chain.
 */
export async function getActiveAuctionCount(
  artistAddress: string,
): Promise<number | null> {
  const lower = artistAddress.toLowerCase()

  // Indexer-first. Ponder writes every PND auction state transition into
  // the same Postgres pgCache uses, so this is a sub-50ms point query —
  // strictly cheaper than the log-scan + multicall fallback. The 500ms
  // hard timeout in the indexer-queries helper means a slow / down /
  // unsynced indexer doesn't add latency to renders.
  const fromIndexer = await getActiveAuctionCountFromIndexer(lower)
  if (fromIndexer !== null) return fromIndexer

  // Fallback: existing L1 + L2 + RPC path. Fully self-contained — works
  // when the indexer is disabled, unreachable, or hasn't caught up to
  // a recent on-chain event yet.
  return getActiveAuctionCountCached(lower)
}

const getActiveAuctionCountCached = unstable_cache(
  (artistAddress: string) =>
    pgCache<number | null>(
      `active-auction-count:${artistAddress}`,
      60 * 5,
      () => getActiveAuctionCountUncached(artistAddress),
    ),
  ["active-auction-count-v1"],
  { revalidate: 60 * 5, tags: ["active-auction-count"] },
)

async function getActiveAuctionCountUncached(
  artistAddress: string,
): Promise<number | null> {
    if (!SOVEREIGN_FACTORY) return null
    const client = getClient()

    let houseAddress: Address
    try {
      houseAddress = await client.readContract({
        address: SOVEREIGN_FACTORY,
        abi: sovereignAuctionHouseFactoryAbi,
        functionName: "houseOf",
        args: [artistAddress as Address],
      })
    } catch {
      return null
    }
    if (houseAddress === ZERO_ADDRESS) return null

    // Bounded by factory deploy block — no houses could exist before that, so
    // scanning from 0 was just paying for a 24M-block null scan every call.
    const created = await client.getLogs({
      address: houseAddress,
      event: parseAbiItem(
        "event AuctionCreated(uint256 indexed auctionId, uint256 indexed tokenId, address indexed tokenContract, uint256 duration, uint256 reservePrice, address tokenOwner)",
      ),
      fromBlock: SOVEREIGN_FACTORY_DEPLOY_BLOCK,
      toBlock: "latest",
    })
    if (created.length === 0) return 0

    const auctionIds = created
      .map((log) => log.args.auctionId)
      .filter((id): id is bigint => id !== undefined)

    // Collapse N parallel `eth_call` round-trips into a single `multicall3`
    // aggregate3 call. For an artist with M auctions in their house's
    // history this drops from M RPC requests to ⌈M / 100⌉ — meaningful at
    // ~50+ auctions and free at any scale. `multicall` ABI-decodes results
    // and returns a per-call `{ status, result }` so a single revert
    // doesn't take down the batch.
    const BATCH_SIZE = 100
    let activeCount = 0
    for (let i = 0; i < auctionIds.length; i += BATCH_SIZE) {
      const batch = auctionIds.slice(i, i + BATCH_SIZE)
      const results = await client.multicall({
        contracts: batch.map((id) => ({
          address: houseAddress,
          abi: sovereignAuctionHouseAbi,
          functionName: "auctions" as const,
          args: [id] as const,
        })),
        allowFailure: true,
      })
      for (const r of results) {
        if (r.status !== "success") continue
        // Tuple index 5 is `tokenOwner` — zero means the contract deleted
        // the entry on settle/cancel.
        const tuple = r.result as readonly [
          bigint, Address, bigint, bigint, bigint, Address, bigint, Address, bigint,
        ]
        if (tuple[5] !== ZERO_ADDRESS) activeCount++
      }
    }
    return activeCount
}

async function readSovereignAuction(
  client: ReturnType<typeof createPublicClient>,
  houseAddress: Address,
  contract: Address,
  tokenIdBig: bigint,
): Promise<AuctionState | null> {
  // getAuctionFor returns (bool exists, uint256 auctionId). Tuple shape
  // disambiguates "no auction" from "auction id 0" — id 0 is a valid id.
  let auctionId: bigint
  try {
    const [exists, id] = (await client.readContract({
      address: houseAddress,
      abi: sovereignAuctionHouseAbi,
      functionName: "getAuctionFor",
      args: [contract, tokenIdBig],
    })) as readonly [boolean, bigint]
    if (!exists) return null
    auctionId = id
  } catch {
    return null
  }

  // Auction struct after the curator removal:
  //   tokenId, tokenContract, firstBidTime (u64), amount, reservePrice,
  //   tokenOwner, endTime (u64), bidder, duration (u64).
  let auction: readonly [
    bigint, Address, bigint, bigint, bigint, Address, bigint, Address, bigint,
  ]
  try {
    auction = (await client.readContract({
      address: houseAddress,
      abi: sovereignAuctionHouseAbi,
      functionName: "auctions",
      args: [auctionId],
    })) as typeof auction
  } catch {
    return null
  }

  const [
    auctionTokenId,
    auctionTokenContract,
    firstBidTime,
    amount,
    reservePrice,
    tokenOwner,
    endTimeRaw,
    bidder,
    duration,
  ] = auction

  if (tokenOwner === ZERO_ADDRESS) return null
  // The auction must reference the token we asked about (defensive — should
  // always be true given the lookup, but cheap to verify).
  if (
    auctionTokenContract.toLowerCase() !== contract.toLowerCase() ||
    auctionTokenId !== tokenIdBig
  ) {
    return null
  }

  // getMinBidAmount returns (bool exists, uint256 minBid).
  let minBidWei: bigint
  try {
    const [, mb] = (await client.readContract({
      address: houseAddress,
      abi: sovereignAuctionHouseAbi,
      functionName: "getMinBidAmount",
      args: [auctionId],
    })) as readonly [boolean, bigint]
    minBidWei = mb
  } catch {
    minBidWei = amount === 0n ? reservePrice : amount
  }

  // PND fees: protocolFeeBps from contract. No curator fee anymore (the
  // role was removed from the contract); no ERC2981 royalty path in v1.
  const protocolFeeBps = await client
    .readContract({
      address: houseAddress,
      abi: sovereignAuctionHouseAbi,
      functionName: "protocolFeeBps",
    })
    .catch(() => 0)
  const protoBps = Number(protocolFeeBps)
  const sellerBps = 10000 - protoBps

  const fees: AuctionFees = {
    platformLabel: "PND",
    protocolFeeBps: protoBps,
    creatorRoyaltyBps: 0,
    sellerBps,
  }

  const rawHistory = await getSovereignBidHistory(
    client,
    houseAddress,
    auctionId,
    bidder === ZERO_ADDRESS ? null : { bidder, amount },
  )

  const awaitingFirstBid = firstBidTime === 0n || bidder === ZERO_ADDRESS
  // endTime is stored on-chain post-first-bid; pre-bid it's zero.
  const endTime = endTimeRaw
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const awaitingSettlement =
    !awaitingFirstBid && endTime > 0n && endTime <= nowSec

  const addressesToResolve: string[] = [tokenOwner]
  if (bidder !== ZERO_ADDRESS) addressesToResolve.push(bidder)
  for (const b of rawHistory) addressesToResolve.push(b.bidder)
  const names = await resolveDisplayNames(addressesToResolve)
  const lookup = (a: Address) => names.get(a.toLowerCase()) ?? a

  return {
    source: "sovereign",
    marketAddress: houseAddress,
    auctionId: auctionId.toString(),
    nftContract: auctionTokenContract,
    tokenId: auctionTokenId.toString(),
    seller: tokenOwner,
    sellerDisplay: lookup(tokenOwner),
    amount: amount === 0n ? reservePrice : amount,
    bidder,
    bidderDisplay: bidder === ZERO_ADDRESS ? "" : lookup(bidder),
    endTime,
    duration,
    minBidWei,
    awaitingFirstBid,
    awaitingSettlement,
    fees,
    bidHistory: rawHistory.map((b) => ({ ...b, bidderDisplay: lookup(b.bidder) })),
  }
}

async function getSovereignBidHistory(
  client: ReturnType<typeof createPublicClient>,
  houseAddress: Address,
  auctionId: bigint,
  expectedTop: { bidder: Address; amount: bigint } | null,
): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">>> {
  // Lazy-table cache (mirrors Foundation's pattern in
  // `getFoundationBidHistory`): read `lazy_pnd_bids` first; if the
  // newest row is fresh (within `LAZY_TTL.pndBids`, 30 min) return it
  // and skip the RPC scan + per-block timestamp round-trips entirely.
  // Skip cache when its top row doesn't match the on-chain leader —
  // `last_indexed_at` only moves on writes, so a fresh cache can still
  // be missing a bid placed since the last scan.
  const auctionIdStr = auctionId.toString()
  const houseStr = houseAddress.toLowerCase()
  const freshness = await readPndBidHistoryFreshness(houseStr, auctionIdStr)
  if (freshness && isFresh(freshness, LAZY_TTL.pndBids)) {
    const cached = await readPndBidHistory(houseStr, auctionIdStr)
    if (cached && cacheCoversTop(cached, expectedTop)) {
      return cached.map((b) => ({
        bidder: b.bidder as Address,
        amount: b.amount,
        blockTime: b.blockTime,
        txHash: b.txHash as `0x${string}`,
      }))
    }
  }

  // Pre-bid short-circuit (mirrors Foundation): no on-chain leader
  // means there's nothing to find in logs.
  if (!expectedTop) {
    const cached = await readPndBidHistory(houseStr, auctionIdStr)
    return (cached ?? []).map((b) => ({
      bidder: b.bidder as Address,
      amount: b.amount,
      blockTime: b.blockTime,
      txHash: b.txHash as `0x${string}`,
    }))
  }

  // Cursor-bounded incremental scan (per-house+auction). Drops
  // steady-state getLogs range from ~25M blocks to whatever
  // accumulated since this auction was last scanned.
  const scanKey = `pnd_bids:${houseStr}:${auctionIdStr}`
  const cursor = await readScanCursor(scanKey)
  const fromBlock = cursor ? cursor.lastBlock + 1n : SOVEREIGN_FACTORY_DEPLOY_BLOCK
  const latest = await client.getBlockNumber().catch(() => null)
  if (latest === null) {
    const cached = await readPndBidHistory(houseStr, auctionIdStr)
    return (cached ?? []).map((b) => ({
      bidder: b.bidder as Address,
      amount: b.amount,
      blockTime: b.blockTime,
      txHash: b.txHash as `0x${string}`,
    }))
  }

  const logs =
    fromBlock > latest
      ? []
      : await client
          .getLogs({
            address: houseAddress,
            event: sovereignBidPlacedEvent,
            args: { auctionId },
            fromBlock,
            toBlock: latest,
          })
          .catch(() => [])

  const enriched = await enrichBidLogs(client, logs, "amount")

  // Persist for the next 30 minutes. Same fire-and-forget shape as
  // `writeFoundationBidHistory` — re-derive logIndex + blockNumber from
  // the raw logs since `enrichBidLogs` strips both.
  if (enriched.length > 0) {
    const logsByTx = new Map<string, number>()
    const blocksByTx = new Map<string, bigint>()
    for (const l of logs) {
      if (l.transactionHash && typeof l.logIndex === "number") {
        logsByTx.set(l.transactionHash, l.logIndex)
      }
      if (l.transactionHash && l.blockNumber !== null) {
        blocksByTx.set(l.transactionHash, l.blockNumber)
      }
    }
    writePndBidHistory(
      houseStr,
      auctionIdStr,
      enriched.map((b) => ({
        txHash: b.txHash,
        logIndex: logsByTx.get(b.txHash) ?? 0,
        bidder: b.bidder,
        amount: b.amount,
        blockTime: b.blockTime,
        blockNumber: blocksByTx.get(b.txHash) ?? 0n,
      })),
    )
  }
  await writeScanCursor(scanKey, latest)

  const cached = (await readPndBidHistory(houseStr, auctionIdStr)) ?? []
  return mergeBidHistory(cached, enriched)
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * True when the cached bid set already includes the on-chain leader.
 * Cache rows are ordered newest-first and bid amounts are monotonically
 * increasing, so the first cached row is the highest. When `expectedTop`
 * is null (no on-chain bidder yet) the cache trivially covers it.
 */
/**
 * Merge cached bid rows with bids freshly scanned by the cursor-bounded
 * incremental getLogs. The two sets can overlap when the cursor is at
 * the same block as already-cached rows; dedupe by txHash (the upsert
 * primary key includes log_index too, but a single tx can carry only
 * one bid per auction). Sort newest-first by amount — bids on both
 * Foundation and PND are monotonically increasing, so amount-DESC
 * matches block-DESC and gives the same order the UI expects.
 */
function mergeBidHistory(
  cached: ReadonlyArray<{
    bidder: string
    amount: bigint
    blockTime: number
    txHash: string
  }>,
  fresh: ReadonlyArray<Omit<BidHistoryEntry, "bidderDisplay">>,
): Array<Omit<BidHistoryEntry, "bidderDisplay">> {
  const map = new Map<string, Omit<BidHistoryEntry, "bidderDisplay">>()
  for (const b of cached) {
    map.set(b.txHash, {
      bidder: b.bidder as Address,
      amount: b.amount,
      blockTime: b.blockTime,
      txHash: b.txHash,
    })
  }
  for (const b of fresh) map.set(b.txHash, b)
  return Array.from(map.values()).sort((a, b) =>
    a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0,
  )
}

function cacheCoversTop(
  cached: ReadonlyArray<{ bidder: string; amount: bigint }>,
  expectedTop: { bidder: Address; amount: bigint } | null,
): boolean {
  if (!expectedTop) return true
  if (cached.length === 0) return false
  const top = cached[0]
  return (
    top.amount === expectedTop.amount &&
    top.bidder.toLowerCase() === expectedTop.bidder.toLowerCase()
  )
}

async function enrichBidLogs(
  client: ReturnType<typeof createPublicClient>,
  logs: ReadonlyArray<{
    args: { bidder?: Address; amount?: bigint }
    blockNumber: bigint | null
    transactionHash: `0x${string}` | null
  }>,
  _amountField: "amount",
): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">>> {
  if (logs.length === 0) return []

  const uniqueBlocks = Array.from(
    new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null)),
  )
  const blockTimes = new Map<bigint, number>()
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      try {
        const block = await client.getBlock({ blockNumber: bn })
        blockTimes.set(bn, Number(block.timestamp))
      } catch {
        blockTimes.set(bn, 0)
      }
    }),
  )

  const entries = logs
    .filter(
      (l): l is typeof l & { blockNumber: bigint; transactionHash: `0x${string}` } =>
        l.blockNumber !== null && l.transactionHash !== null,
    )
    .map((l) => ({
      bidder: l.args.bidder as Address,
      amount: l.args.amount as bigint,
      blockTime: blockTimes.get(l.blockNumber) ?? 0,
      txHash: l.transactionHash,
    }))

  entries.sort((a, b) => b.blockTime - a.blockTime)
  return entries
}

function weiToBps(part: bigint, total: bigint): number {
  if (total === 0n) return 0
  return Number((part * 10000n) / total)
}
