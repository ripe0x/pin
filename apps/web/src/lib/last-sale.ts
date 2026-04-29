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
import { sovereignAuctionHouseFactoryAbi } from "@pin/abi"
import { pgCache } from "./pg-cache"
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
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// NFTMarket proxy was deployed Dec 2021 — earlier scanning is wasted RPC.
const FND_MARKET_DEPLOY_BLOCK = 13_840_000n
// SovereignAuctionHouseFactory was deployed in 2026 (PND launch) — every
// sovereign house was deployed by it, so no log we care about exists earlier.
// Verified via `cast code` binary search.
const SOVEREIGN_FACTORY_DEPLOY_BLOCK = 24_956_103n

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

async function getFoundationLastSale(
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

async function getSovereignLastSale(
  client: ReturnType<typeof createPublicClient>,
  nftContract: Address,
  tokenId: bigint,
  creator: Address,
): Promise<LastSale | null> {
  if (!SOVEREIGN_FACTORY) return null

  let houseAddress: Address
  try {
    houseAddress = await client.readContract({
      address: SOVEREIGN_FACTORY,
      abi: sovereignAuctionHouseFactoryAbi,
      functionName: "houseOf",
      args: [creator],
    })
  } catch {
    return null
  }
  if (houseAddress === ZERO_ADDRESS) return null

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
  const client = getClient()
  const contract = nftContract as Address
  const tokenIdBig = BigInt(tokenId)

  const [foundation, sovereign] = await Promise.all([
    getFoundationLastSale(client, contract, tokenIdBig),
    creator
      ? getSovereignLastSale(client, contract, tokenIdBig, creator as Address)
      : Promise.resolve(null),
  ])

  let pick: LastSale | null = null
  if (foundation && sovereign) {
    pick = foundation.blockTime >= sovereign.blockTime ? foundation : sovereign
  } else {
    pick = foundation ?? sovereign
  }
  if (!pick) return null
  return {
    priceWei: pick.priceWei.toString(),
    blockTime: pick.blockTime,
    source: pick.source,
    txHash: pick.txHash,
  }
}

const cached = unstable_cache(
  (nftContract: string, tokenId: string, creator: string) =>
    pgCache(
      `last-sale:${nftContract.toLowerCase()}:${tokenId}`,
      3600,
      () => getLastSalePriceCached(nftContract, tokenId, creator),
    ),
  ["last-sale-v1"],
  { revalidate: 3600 },
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
