/**
 * Last-sale price lookup for a single token across both auction sources
 * we index ourselves (Foundation legacy NFTMarket + Sovereign auction
 * houses). Sales on other marketplaces (OpenSea/Blur/etc.) are NOT covered.
 *
 * Strategy: settled auctions are deleted from contract storage, so we get
 * the price from event logs. For each source we:
 *   1. Scan AuctionCreated logs filtered by (nftContract, tokenId)
 *      → list of auctionIds for this token
 *   2. Scan finalize logs (ReserveAuctionFinalized / AuctionEnded) for
 *      those auctionIds → final sale price + block timestamp
 *   3. Pick the most recent.
 * Then merge across sources and return the most recent overall.
 *
 * Wrapped in `unstable_cache` because settled prices don't change.
 */
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { unstable_cache } from "next/cache"
import { pgCache } from "./pg-cache"
import {
  readFoundationLastSale,
  writeFoundationLastSale,
  LAZY_TTL,
  isFresh,
} from "./lazy-index"
import { getSovereignHouseOf } from "./sovereign-house"
import {
  NFT_MARKET,
  MAINNET_CHAIN_ID,
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  getAddressOrNull,
} from "@pin/addresses"

const FND_MARKET = NFT_MARKET[MAINNET_CHAIN_ID]
const SOVEREIGN_FACTORY = getAddressOrNull(
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  MAINNET_CHAIN_ID,
)

// NFTMarket proxy was deployed Dec 2021 — earlier scanning is wasted RPC.
const FND_MARKET_DEPLOY_BLOCK = 13_840_000n
// SovereignAuctionHouseFactory was deployed in 2026 (PND launch) — every
// sovereign house was deployed by it, so no log we care about exists
// earlier. Verified: `cast code` returns 0x at 24,973,293 and real
// bytecode at 24,973,294.
const SOVEREIGN_FACTORY_DEPLOY_BLOCK = 24_973_294n

const fndCreatedEvent = parseAbiItem(
  "event ReserveAuctionCreated(address indexed seller, address indexed nftContract, uint256 indexed tokenId, uint256 duration, uint256 extensionDuration, uint256 reservePrice, uint256 auctionId)",
)
const fndFinalizedEvent = parseAbiItem(
  "event ReserveAuctionFinalized(uint256 indexed auctionId, address indexed seller, address indexed bidder, uint256 totalFees, uint256 creatorRev, uint256 sellerRev)",
)

const sovCreatedEvent = parseAbiItem(
  "event AuctionCreated(uint256 indexed auctionId, uint256 indexed tokenId, address indexed tokenContract, uint256 duration, uint256 reservePrice, address tokenOwner)",
)
const sovEndedEvent = parseAbiItem(
  "event AuctionEnded(uint256 indexed auctionId, address tokenOwner, address winner, uint256 sellerProceeds, uint256 protocolFee)",
)

export type LastSale = {
  priceWei: bigint
  blockTime: number
  source: "foundation" | "sovereign"
  txHash: string
}

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ??
        "https://eth.llamarpc.com",
    ),
  })
}

export async function getFoundationLastSale(
  client: ReturnType<typeof createPublicClient>,
  nftContract: Address,
  tokenId: bigint,
): Promise<LastSale | null> {
  // Lazy index read: if a recent row exists, return it without RPC.
  const cached = await readFoundationLastSale(nftContract, tokenId.toString())
  if (cached && isFresh(cached.lastIndexedAt, LAZY_TTL.foundationSale)) {
    return {
      priceWei: cached.priceWei,
      blockTime: cached.blockTime,
      source: "foundation",
      txHash: cached.txHash,
    }
  }

  const sale = await scanFoundationLastSale(client, nftContract, tokenId)
  // Fire-and-forget UPSERT so the next miss within the TTL window collapses
  // to a Postgres point lookup.
  if (sale) {
    writeFoundationLastSale(nftContract, tokenId.toString(), {
      priceWei: sale.priceWei,
      blockTime: sale.blockTime,
      source: "auction", // we'll widen this to buyNow once we lazy-index acceptances
      txHash: sale.txHash,
    })
  }
  return sale
}

async function scanFoundationLastSale(
  client: ReturnType<typeof createPublicClient>,
  nftContract: Address,
  tokenId: bigint,
): Promise<LastSale | null> {
  const created = await client
    .getLogs({
      address: FND_MARKET,
      event: fndCreatedEvent,
      args: { nftContract, tokenId },
      fromBlock: FND_MARKET_DEPLOY_BLOCK,
      toBlock: "latest",
    })
    .catch(() => [])

  if (created.length === 0) return null
  const auctionIds = created
    .map((log) => log.args.auctionId)
    .filter((id): id is bigint => id !== undefined)
  if (auctionIds.length === 0) return null

  // viem accepts an array for indexed args → topic1 OR-match in one call.
  const finalized = await client
    .getLogs({
      address: FND_MARKET,
      event: fndFinalizedEvent,
      args: { auctionId: auctionIds },
      fromBlock: FND_MARKET_DEPLOY_BLOCK,
      toBlock: "latest",
    })
    .catch(() => [])

  if (finalized.length === 0) return null

  const sorted = [...finalized].sort((a, b) => {
    const ab = a.blockNumber ?? 0n
    const bb = b.blockNumber ?? 0n
    return ab > bb ? -1 : ab < bb ? 1 : 0
  })
  const latest = sorted[0]
  const args = latest.args as {
    totalFees?: bigint
    creatorRev?: bigint
    sellerRev?: bigint
  }
  const priceWei =
    (args.totalFees ?? 0n) + (args.creatorRev ?? 0n) + (args.sellerRev ?? 0n)
  if (priceWei === 0n) return null

  const block = await client
    .getBlock({ blockNumber: latest.blockNumber ?? 0n })
    .catch(() => null)
  if (!block) return null

  return {
    priceWei,
    blockTime: Number(block.timestamp),
    source: "foundation",
    txHash: latest.transactionHash ?? "",
  }
}

export async function getSovereignLastSale(
  client: ReturnType<typeof createPublicClient>,
  nftContract: Address,
  tokenId: bigint,
  creator: Address,
): Promise<LastSale | null> {
  if (!SOVEREIGN_FACTORY) return null

  // Cached lookup — see sovereign-house.ts. Houses don't move, so a 24h
  // cross-sandbox cache eliminates the per-render eth_call.
  const houseAddress = await getSovereignHouseOf(creator)
  if (!houseAddress) return null

  const created = await client
    .getLogs({
      address: houseAddress,
      event: sovCreatedEvent,
      args: { tokenContract: nftContract, tokenId },
      fromBlock: SOVEREIGN_FACTORY_DEPLOY_BLOCK,
      toBlock: "latest",
    })
    .catch(() => [])

  if (created.length === 0) return null
  const auctionIds = created
    .map((log) => log.args.auctionId)
    .filter((id): id is bigint => id !== undefined)
  if (auctionIds.length === 0) return null

  const ended = await client
    .getLogs({
      address: houseAddress,
      event: sovEndedEvent,
      args: { auctionId: auctionIds },
      fromBlock: SOVEREIGN_FACTORY_DEPLOY_BLOCK,
      toBlock: "latest",
    })
    .catch(() => [])

  if (ended.length === 0) return null

  const sorted = [...ended].sort((a, b) => {
    const ab = a.blockNumber ?? 0n
    const bb = b.blockNumber ?? 0n
    return ab > bb ? -1 : ab < bb ? 1 : 0
  })
  const latest = sorted[0]
  const args = latest.args as {
    sellerProceeds?: bigint
    protocolFee?: bigint
  }
  // Sovereign's AuctionEnded doesn't break out creator royalty separately;
  // sellerProceeds + protocolFee is the closest approximation of the winning
  // bid amount the contract emits. (Creator royalty is paid out of the same
  // pot via the registry, so this is at-most a small under-count.)
  const priceWei = (args.sellerProceeds ?? 0n) + (args.protocolFee ?? 0n)
  if (priceWei === 0n) return null

  const block = await client
    .getBlock({ blockNumber: latest.blockNumber ?? 0n })
    .catch(() => null)
  if (!block) return null

  return {
    priceWei,
    blockTime: Number(block.timestamp),
    source: "sovereign",
    txHash: latest.transactionHash ?? "",
  }
}

type CachedSale = {
  priceWei: string
  blockTime: number
  source: "foundation" | "sovereign"
  txHash: string
} | null

async function getLastSalePriceCached(
  nftContract: string,
  tokenId: string,
  creator: string,
): Promise<CachedSale> {
  const contract = nftContract as Address
  const creatorAddr =
    creator && creator !== "" ? (creator as Address) : null

  // Loop the platform registry. Each adapter's `getLastSale` returns its
  // own most-recent sale (lazy-cached internally). We pick the
  // most-recent across all platforms.
  const { PLATFORMS } = await import("./platforms")
  const sales = await Promise.all(
    PLATFORMS.map((p) => p.getLastSale(contract, tokenId, creatorAddr)),
  )
  const valid = sales.filter(
    (s): s is NonNullable<typeof s> => s !== null && s.priceWei > 0n,
  )
  if (valid.length === 0) return null
  valid.sort((a, b) => b.blockTime - a.blockTime)
  const pick = valid[0]
  // Narrow the platform-defined `source` string back to the existing
  // CachedSale union for callers that haven't been generalized yet.
  // For now the only platforms returning sales are foundation + sovereign;
  // both already use values that fit the union. New platforms will need
  // a wider union or a separate type.
  const source: "foundation" | "sovereign" =
    pick.platform === "sovereign" ? "sovereign" : "foundation"
  return {
    priceWei: pick.priceWei.toString(),
    blockTime: pick.blockTime,
    source,
    txHash: pick.txHash,
  }
}

// Settled prices are immutable on-chain. The /api/revalidate flush hits both
// the `last-sale` tag (for unstable_cache) and the `last-sale:` pgCache prefix
// when an event lands, so the long TTL is safe.
const LAST_SALE_TTL_S = 7 * 86_400

const cached = unstable_cache(
  (nftContract: string, tokenId: string, creator: string) =>
    pgCache(
      `last-sale:${nftContract.toLowerCase()}:${tokenId}`,
      LAST_SALE_TTL_S,
      () => getLastSalePriceCached(nftContract, tokenId, creator),
    ),
  ["last-sale-v1"],
  { revalidate: LAST_SALE_TTL_S, tags: ["last-sale"] },
)

export async function getLastSalePriceForToken(
  nftContract: string,
  tokenId: string,
  creator: string,
): Promise<LastSale | null> {
  const result = await cached(nftContract, tokenId, creator)
  if (!result) return null
  return {
    priceWei: BigInt(result.priceWei),
    blockTime: result.blockTime,
    source: result.source,
    txHash: result.txHash,
  }
}
