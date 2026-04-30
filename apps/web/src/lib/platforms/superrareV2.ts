import "server-only"
import {
  createPublicClient,
  http,
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
  LAZY_TTL,
  isFresh,
} from "../lazy-index"
import { refreshSuperrareV2Auctions } from "./superrareV2-scan"

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
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ??
        "https://eth.llamarpc.com",
      { batch: true },
    ),
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
 * SuperRare V2 platform adapter.
 *
 * Discovery strategy (cost-bounded by indexed-arg event filters):
 *   - Artist mints: Transfer(from=0x0, to=artist) on the V2 NFT contract.
 *     Filter is on indexed `from` + `to` so Alchemy returns only this
 *     artist's mints — typically <50 logs per artist, one cheap scan.
 *   - Last sale: AuctionSettled filtered by indexed `_contractAddress`
 *     and `_tokenId`. Sold/AcceptOffer events are NOT indexed by tokenId,
 *     so direct-buy + offer-accept sales are NOT covered today (deferred
 *     follow-up — would need a platform-wide bulk scan).
 *   - Collector tokens: Alchemy NFT API `getNFTsForOwner` filtered to
 *     the V2 NFT contract — one billable page (~150 CU).
 *   - Active auctions: incremental scan of NewAuction/AuctionBid/
 *     AuctionSettled/CancelAuction on Bazaar. Cursor-based; see
 *     `superrareV2-scan.ts`.
 *
 * Bid currency: only ETH bids (currencyAddress = 0x0) surface in our UI.
 * ERC-20 bids are rare on V2 and out of scope for the MVP.
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
    // Only V2 NFT tokens can have sales on Bazaar that we track. Tokens
    // on other contracts aren't ours to claim a sale for.
    if (contract.toLowerCase() !== SR_V2_NFT.toLowerCase()) return null

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
    if (contract.toLowerCase() !== SR_V2_NFT.toLowerCase()) return null

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

    const addressesToResolve: string[] = [auctionCreator]
    if (bidder !== ZERO_ADDRESS) addressesToResolve.push(bidder)
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
      bidHistory: [],
    }
  },

  async getActiveAuctions(limit: number): Promise<ActiveAuctionSummary[]> {
    // Refresh first; the scan has its own cooldown so consecutive calls
    // within the cursor freshness window are no-ops.
    await refreshSuperrareV2Auctions().catch(() => {
      // Scan failures fall back to whatever rows exist in the table; the
      // home grid degrades gracefully rather than crashing.
    })

    const rows = await readSuperrareV2ActiveAuctions(limit)
    return rows.map((r) => ({
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
