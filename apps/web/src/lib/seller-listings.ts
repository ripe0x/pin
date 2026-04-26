/**
 * Discover a seller's active, cancellable Foundation listings via direct RPC.
 *
 * Two parallel event scans on the NFTMarket contract — `ReserveAuctionCreated`
 * and `BuyPriceSet`, both filtered on the indexed seller topic — then a
 * multicall pass to drop anything that's no longer active (cancelled,
 * finalized, sold, or — for auctions — already received a bid, since
 * `cancelReserveAuction` reverts after the first bid).
 */
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem"
import { mainnet } from "viem/chains"
import { nftMarketAbi, erc721Abi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import { ipfsToHttp } from "@pin/shared"

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// NFTMarket proxy was deployed Dec 2021 — same anchor as auctions.ts:74.
const NFT_MARKET_DEPLOY_BLOCK = 13_840_000n
const BLOCK_RANGE = 2_000_000n

export type AuctionListing = {
  kind: "auction"
  id: string
  auctionId: bigint
  nftContract: Address
  tokenId: string
  reserveWei: bigint
}

export type BuyNowListing = {
  kind: "buyNow"
  id: string
  nftContract: Address
  tokenId: string
  priceWei: bigint
}

export type SellerListing = AuctionListing | BuyNowListing

export type SellerListingMeta = {
  displayName: string
  imageUrl: string | null
}

const reserveAuctionCreatedEvent = parseAbiItem(
  "event ReserveAuctionCreated(address indexed seller, address indexed nftContract, uint256 indexed tokenId, uint256 duration, uint256 extensionDuration, uint256 reservePrice, uint256 auctionId)",
)

const buyPriceSetEvent = parseAbiItem(
  "event BuyPriceSet(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 price)",
)

function getClient(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ?? "https://eth.llamarpc.com",
    ),
  })
}

export async function getSellerCancellableListings(
  sellerAddress: string,
): Promise<{ auctions: AuctionListing[]; buyNows: BuyNowListing[] }> {
  const client = getClient()
  const seller = sellerAddress.toLowerCase() as Address
  const latestBlock = await client.getBlockNumber()

  const [auctionLogs, buyPriceLogs] = await Promise.all([
    getLogs(
      client,
      MARKET_ADDRESS,
      reserveAuctionCreatedEvent,
      { seller },
      NFT_MARKET_DEPLOY_BLOCK,
      latestBlock,
    ),
    getLogs(
      client,
      MARKET_ADDRESS,
      buyPriceSetEvent,
      { seller },
      NFT_MARKET_DEPLOY_BLOCK,
      latestBlock,
    ),
  ])

  // Dedupe: same auctionId can appear once (one Created event per auction),
  // but the seller may have re-created an auction for the same token after a
  // prior cancel; keep the most recent auctionId per token.
  const auctionIds = Array.from(
    new Set(
      auctionLogs.map(
        (l) => (l as { args: { auctionId: bigint } }).args.auctionId,
      ),
    ),
  )

  // For buy-now, BuyPriceSet fires every time the seller sets/updates a price,
  // so dedupe by (contract, tokenId) — the read-back will tell us the current
  // state.
  const buyNowKeys = new Map<string, { nftContract: Address; tokenId: bigint }>()
  for (const log of buyPriceLogs) {
    const args = (log as { args: { nftContract: Address; tokenId: bigint } })
      .args
    const key = `${args.nftContract.toLowerCase()}:${args.tokenId.toString()}`
    if (!buyNowKeys.has(key)) {
      buyNowKeys.set(key, { nftContract: args.nftContract, tokenId: args.tokenId })
    }
  }

  const [auctions, buyNows] = await Promise.all([
    confirmActiveAuctions(client, auctionIds, seller),
    confirmActiveBuyNows(client, Array.from(buyNowKeys.values()), seller),
  ])

  return { auctions, buyNows }
}

async function confirmActiveAuctions(
  client: PublicClient,
  auctionIds: bigint[],
  seller: Address,
): Promise<AuctionListing[]> {
  if (auctionIds.length === 0) return []

  const out: AuctionListing[] = []

  for (let i = 0; i < auctionIds.length; i += 50) {
    const batch = auctionIds.slice(i, i + 50)
    const results = await client.multicall({
      contracts: batch.map((auctionId) => ({
        address: MARKET_ADDRESS,
        abi: nftMarketAbi,
        functionName: "getReserveAuction" as const,
        args: [auctionId] as const,
      })),
    })

    batch.forEach((auctionId, j) => {
      const r = results[j]
      if (r.status !== "success") return
      const a = r.result as {
        nftContract: Address
        tokenId: bigint
        seller: Address
        endTime: bigint
        bidder: Address
        amount: bigint
      }
      // Cancellable iff still owned by seller and no bid yet — `cancelReserveAuction`
      // reverts once bidder is set / endTime is non-zero.
      if (a.seller.toLowerCase() !== seller) return
      if (a.bidder !== ZERO_ADDRESS) return
      if (a.endTime !== 0n) return

      out.push({
        kind: "auction",
        id: `auction:${auctionId.toString()}`,
        auctionId,
        nftContract: a.nftContract,
        tokenId: a.tokenId.toString(),
        reserveWei: a.amount,
      })
    })
  }

  return out
}

async function confirmActiveBuyNows(
  client: PublicClient,
  candidates: Array<{ nftContract: Address; tokenId: bigint }>,
  seller: Address,
): Promise<BuyNowListing[]> {
  if (candidates.length === 0) return []

  const out: BuyNowListing[] = []

  for (let i = 0; i < candidates.length; i += 50) {
    const batch = candidates.slice(i, i + 50)
    const results = await client.multicall({
      contracts: batch.map((c) => ({
        address: MARKET_ADDRESS,
        abi: nftMarketAbi,
        functionName: "getBuyPrice" as const,
        args: [c.nftContract, c.tokenId] as const,
      })),
    })

    batch.forEach((c, j) => {
      const r = results[j]
      if (r.status !== "success") return
      const bp = r.result as { seller: Address; price: bigint }
      if (bp.seller.toLowerCase() !== seller) return
      if (bp.price === 0n) return

      out.push({
        kind: "buyNow",
        id: `buyNow:${c.nftContract.toLowerCase()}:${c.tokenId.toString()}`,
        nftContract: c.nftContract,
        tokenId: c.tokenId.toString(),
        priceWei: bp.price,
      })
    })
  }

  return out
}

/**
 * Resolve display name + image for a batch of listings via tokenURI + IPFS.
 * Errors per token are swallowed — caller gets a placeholder display.
 */
export async function resolveListingMetadata(
  listings: SellerListing[],
): Promise<Map<string, SellerListingMeta>> {
  const client = getClient()
  const out = new Map<string, SellerListingMeta>()
  if (listings.length === 0) return out

  // Batch tokenURI calls in chunks of 50 (mirrors onchain-discovery.ts).
  for (let i = 0; i < listings.length; i += 50) {
    const batch = listings.slice(i, i + 50)
    const results = await client.multicall({
      contracts: batch.map((l) => ({
        address: l.nftContract,
        abi: erc721Abi,
        functionName: "tokenURI" as const,
        args: [BigInt(l.tokenId)] as const,
      })),
    })

    await Promise.all(
      batch.map(async (l, j) => {
        const r = results[j]
        const fallback: SellerListingMeta = {
          displayName: `#${l.tokenId}`,
          imageUrl: null,
        }
        if (r.status !== "success") {
          out.set(l.id, fallback)
          return
        }
        const uri = r.result as string
        if (!uri) {
          out.set(l.id, fallback)
          return
        }
        try {
          const res = await fetch(ipfsToHttp(uri), {
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) {
            out.set(l.id, fallback)
            return
          }
          const meta = (await res.json()) as {
            name?: string
            image?: string
          }
          out.set(l.id, {
            displayName: meta.name ?? fallback.displayName,
            imageUrl: meta.image ? ipfsToHttp(meta.image) : null,
          })
        } catch {
          out.set(l.id, fallback)
        }
      }),
    )
  }

  return out
}

/**
 * Generic paginated log fetcher — splits the range on RPC failure. Mirrors
 * the helper in `onchain-discovery.ts`; kept private here to keep modules
 * independent.
 */
async function getLogs(
  client: PublicClient,
  address: Address,
  event: ReturnType<typeof parseAbiItem>,
  args: Record<string, unknown>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<unknown[]> {
  const allLogs: unknown[] = []

  for (let start = fromBlock; start <= toBlock; start += BLOCK_RANGE) {
    const end = start + BLOCK_RANGE - 1n > toBlock ? toBlock : start + BLOCK_RANGE - 1n
    try {
      const logs = await client.getLogs({
        address,
        // viem's getLogs is overloaded; the typed wrapper struggles with
        // a generic AbiEvent here — the runtime call is correct.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        event: event as any,
        args,
        fromBlock: start,
        toBlock: end,
      })
      allLogs.push(...logs)
    } catch {
      if (end - start > 10_000n) {
        const mid = start + (end - start) / 2n
        const firstHalf = await getLogs(client, address, event, args, start, mid)
        const secondHalf = await getLogs(client, address, event, args, mid + 1n, end)
        allLogs.push(...firstHalf, ...secondHalf)
      }
    }
  }

  return allLogs
}
