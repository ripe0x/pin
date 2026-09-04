/**
 * Global Transient Labs Auction House tracker. One fixed marketplace cursor
 * replaces the former known_artists x block-range fanout.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { getFinalizedBoundary } from "../finality.ts"
import { throttleRpc } from "../throttle.ts"
import { getAddress, parseAbiItem, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"

const TL_AUCTION_HOUSE = "0x6f66b95a0C512f3497FB46660E0BC3B94B989F8d" as const
const TL_AH_DEPLOY_BLOCK = 24_500_000n
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
const CHUNK_SIZE = 9_500n
const MAX_CHUNKS_PER_TICK = 50
const TASK = "scan-tl-active-auctions"
const SCOPE = "global"

const listingConfiguredEvent = parseAbiItem(
  "event ListingConfigured(address indexed sender, address indexed nftAddress, uint256 indexed tokenId, (uint8,bool,address,address,address,uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256) listing)",
)

const getListingAbi = [{
  type: "function", name: "getListing", stateMutability: "view",
  inputs: [{ name: "nftAddress", type: "address" }, { name: "tokenId", type: "uint256" }],
  outputs: [{
    type: "tuple",
    components: [
      { name: "type_", type: "uint8" },
      { name: "zeroProtocolFee", type: "bool" },
      { name: "seller", type: "address" },
      { name: "payoutReceiver", type: "address" },
      { name: "currencyAddress", type: "address" },
      { name: "openTime", type: "uint256" },
      { name: "reservePrice", type: "uint256" },
      { name: "buyNowPrice", type: "uint256" },
      { name: "duration", type: "uint256" },
      { name: "startTime", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "highestBidder", type: "address" },
      { name: "highestBid", type: "uint256" },
      { name: "id", type: "uint256" },
    ],
  }],
}] as const

type Candidate = { contract: Address; tokenId: bigint; seller: string }

type Listing = {
  type_: number
  seller: string
  currencyAddress: string
  reservePrice: bigint
  highestBid: bigint
  highestBidder: string
  startTime: bigint
  duration: bigint
}

export async function scanTlActiveAuctions(): Promise<TaskResult> {
  const artistRows = (await sql`SELECT address FROM known_artists`) as Array<{
    address: string
  }>
  const knownArtists = new Set(artistRows.map(({ address }) => address.toLowerCase()))
  if (knownArtists.size === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const boundary = await getFinalizedBoundary(client)
  const head = boundary.blockNumber
  let rpcCalls = boundary.rpcCalls
  const cursorRows = (await sql`
    SELECT last_block::text AS last_block FROM worker_cursors
    WHERE task = ${TASK} AND scope = ${SCOPE} LIMIT 1
  `) as Array<{ last_block: string }>
  let cursor = cursorRows[0]
    ? BigInt(cursorRows[0].last_block) + 1n
    : TL_AH_DEPLOY_BLOCK
  if (cursor > head) return { scopeCount: 1, rpcCalls, rowsWritten: 0 }

  const candidates = new Map<string, Candidate>()
  let chunks = 0
  while (cursor <= head && chunks < MAX_CHUNKS_PER_TICK) {
    const toBlock = cursor + CHUNK_SIZE - 1n > head ? head : cursor + CHUNK_SIZE - 1n
    await throttleRpc()
    const logs = await client.getLogs({
      address: TL_AUCTION_HOUSE,
      event: listingConfiguredEvent,
      fromBlock: cursor,
      toBlock,
    })
    rpcCalls += 1
    for (const log of logs) {
      const seller = log.args.sender?.toLowerCase()
      const contract = log.args.nftAddress
      const tokenId = log.args.tokenId
      if (!seller || !knownArtists.has(seller) || !contract || tokenId === undefined) continue
      candidates.set(`${contract.toLowerCase()}:${tokenId}`, { contract, tokenId, seller })
    }
    cursor = toBlock + 1n
    chunks += 1
  }
  const scannedThrough = cursor - 1n

  if (scannedThrough === head) {
    const existing = (await sql`
      SELECT contract, token_id, seller FROM tl_active_auctions WHERE status = 'active'
    `) as Array<{ contract: string; token_id: string; seller: string }>
    for (const row of existing) {
      const key = `${row.contract.toLowerCase()}:${row.token_id}`
      if (!candidates.has(key)) {
        candidates.set(key, {
          contract: getAddress(row.contract),
          tokenId: BigInt(row.token_id),
          seller: row.seller.toLowerCase(),
        })
      }
    }
  }

  const list = [...candidates.values()]
  const results = list.length === 0 ? [] : await client.multicall({
    contracts: list.map((candidate) => ({
      address: TL_AUCTION_HOUSE,
      abi: getListingAbi,
      functionName: "getListing" as const,
      args: [candidate.contract, candidate.tokenId] as const,
    })),
    allowFailure: true,
    blockNumber: head,
  })
  if (list.length > 0) rpcCalls += Math.max(1, Math.ceil(list.length / 250))
  const failed = results.findIndex((result) => result.status === "failure")
  if (failed !== -1) {
    throw new Error(`TL listing multicall failed at result ${failed}; cursor unchanged`)
  }

  let rowsWritten = 0
  await sql.begin(async (tx) => {
    for (let index = 0; index < list.length; index++) {
      const candidate = list[index]
      const listing = results[index]!.result as Listing
      const active = listing.type_ !== 0 && listing.currencyAddress.toLowerCase() === ZERO_ADDRESS
      const seller = active ? listing.seller.toLowerCase() : candidate.seller
      const changed = await tx`
        INSERT INTO tl_active_auctions
          (contract, token_id, seller, reserve_wei, current_bid_wei,
           current_bidder, end_time, listing_type, status,
           last_observed_block, updated_at)
        VALUES
          (${candidate.contract.toLowerCase()}, ${candidate.tokenId.toString()}, ${seller},
           ${listing.reservePrice.toString()}, ${listing.highestBid.toString()},
           ${listing.highestBidder.toLowerCase() === ZERO_ADDRESS ? null : listing.highestBidder.toLowerCase()},
           ${Number(listing.startTime > 0n ? listing.startTime + listing.duration : 0n)},
           ${listing.type_}, ${active ? "active" : "settled"},
           ${head.toString()}::bigint, NOW())
        ON CONFLICT (contract, token_id) DO UPDATE SET
          seller = EXCLUDED.seller,
          reserve_wei = EXCLUDED.reserve_wei,
          current_bid_wei = EXCLUDED.current_bid_wei,
          current_bidder = EXCLUDED.current_bidder,
          end_time = EXCLUDED.end_time,
          listing_type = EXCLUDED.listing_type,
          status = EXCLUDED.status,
          last_observed_block = EXCLUDED.last_observed_block,
          updated_at = NOW()
        WHERE (tl_active_auctions.seller, tl_active_auctions.reserve_wei,
               tl_active_auctions.current_bid_wei, tl_active_auctions.current_bidder,
               tl_active_auctions.end_time, tl_active_auctions.listing_type,
               tl_active_auctions.status)
          IS DISTINCT FROM
              (EXCLUDED.seller, EXCLUDED.reserve_wei, EXCLUDED.current_bid_wei,
               EXCLUDED.current_bidder, EXCLUDED.end_time, EXCLUDED.listing_type,
               EXCLUDED.status)
        RETURNING 1
      `
      rowsWritten += changed.count
    }

    await tx`
      INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
      VALUES (${TASK}, ${SCOPE}, ${scannedThrough.toString()}::bigint, NOW())
      ON CONFLICT (task, scope) DO UPDATE SET
        last_block = EXCLUDED.last_block, last_run_at = NOW()
    `
  })

  return { scopeCount: 1, rpcCalls, rowsWritten }
}
