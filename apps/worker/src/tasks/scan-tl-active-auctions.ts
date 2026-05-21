/**
 * Per-artist TL Auction House active-listing tracker. Mirror of
 * scan-srv2-active-auctions for Transient Labs. Writes to
 * `tl_active_auctions` for web pure-Postgres reads.
 *
 * TL's listing struct lives on `getListing(nftAddress, tokenId)` and
 * carries the full state (seller, currency, reserve, bid, etc.) — no
 * separate bid call needed. type_ enum:
 *   0 = NotConfigured (settled/cancelled)
 *   1 = Scheduled auction
 *   2 = Reserve auction ← what we surface
 *   3 = BuyNow
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import {
  getAddress, parseAbiItem, type Address,
} from "viem"
import type { TaskResult } from "../scheduler.ts"

const TL_AUCTION_HOUSE = "0x6f66b95a0C512f3497FB46660E0BC3B94B989F8d" as const
const TL_AH_DEPLOY_BLOCK = 24_500_000n
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
const ETH_CURRENCY = ZERO_ADDRESS
const CHUNK_SIZE = 10_000n
const MAX_CHUNKS_PER_TICK = 50

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

const TASK = "scan-tl-active-auctions"

export async function scanTlActiveAuctions(): Promise<TaskResult> {
  if (!sql) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const artists = (await sql`
    SELECT address FROM known_artists
  `) as Array<{ address: string }>
  if (artists.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const head = await client.getBlockNumber()
  let rpcCalls = 1
  let rowsWritten = 0

  for (const { address } of artists) {
    try {
      const r = await scanOneArtist(address, head)
      rpcCalls += r.rpcCalls
      rowsWritten += r.rowsWritten
    } catch (err) {
      console.error(`[${TASK}] ${address}:`, err)
    }
  }
  return { scopeCount: artists.length, rpcCalls, rowsWritten }
}

async function scanOneArtist(
  artist: string, head: bigint,
): Promise<{ rpcCalls: number; rowsWritten: number }> {
  if (!sql) return { rpcCalls: 0, rowsWritten: 0 }
  const lower = artist.toLowerCase()
  const scope = `tl:${lower}`

  const cursorRow = (await sql`
    SELECT last_block::text AS last_block FROM worker_cursors
    WHERE task = ${TASK} AND scope = ${scope} LIMIT 1
  `) as Array<{ last_block: string }>
  let cursor = cursorRow[0]
    ? BigInt(cursorRow[0].last_block) + 1n
    : TL_AH_DEPLOY_BLOCK

  let rpcCalls = 0

  // Walk forward in 10K chunks collecting ListingConfigured candidates.
  const candidates = new Map<string, { contract: Address; tokenId: bigint }>()
  let chunks = 0
  while (cursor <= head && chunks < MAX_CHUNKS_PER_TICK) {
    const toBlock = cursor + CHUNK_SIZE - 1n > head ? head : cursor + CHUNK_SIZE - 1n
    await throttleRpc()
    const logs = await client.getLogs({
      address: TL_AUCTION_HOUSE,
      event: listingConfiguredEvent,
      args: { sender: getAddress(lower) as Address },
      fromBlock: cursor,
      toBlock,
    })
    rpcCalls += 1
    for (const l of logs) {
      const c = l.args.nftAddress as Address
      const t = l.args.tokenId as bigint
      candidates.set(`${c.toLowerCase()}:${t.toString()}`, { contract: c, tokenId: t })
    }
    cursor = toBlock + 1n
    chunks++
  }

  // Re-check previously-active rows for state changes.
  const existing = (await sql`
    SELECT contract, token_id FROM tl_active_auctions
    WHERE seller = ${lower} AND status = 'active'
  `) as Array<{ contract: string; token_id: string }>
  for (const e of existing) {
    const key = `${e.contract.toLowerCase()}:${e.token_id}`
    if (!candidates.has(key)) {
      candidates.set(key, {
        contract: getAddress(e.contract) as Address,
        tokenId: BigInt(e.token_id),
      })
    }
  }

  if (candidates.size === 0) {
    if (chunks > 0) await advanceCursor(scope, cursor - 1n)
    return { rpcCalls, rowsWritten: 0 }
  }

  // Multicall getListing for every candidate.
  const list = Array.from(candidates.values())
  const calls = list.map((c) => ({
    address: TL_AUCTION_HOUSE, abi: getListingAbi,
    functionName: "getListing" as const,
    args: [c.contract, c.tokenId] as const,
  }))
  const results = (await client.multicall({
    contracts: calls,
    allowFailure: true,
  })) as Array<{ status: "success"; result: unknown } | { status: "failure" }>
  rpcCalls += Math.ceil(calls.length / 250)

  let rowsWritten = 0
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    const r = results[i]
    if (r.status !== "success") continue
    const listing = r.result as {
      type_: number; seller: string; currencyAddress: string;
      reservePrice: bigint; highestBid: bigint;
      highestBidder: string; startTime: bigint; duration: bigint;
    }

    // type_=0 means settled/cancelled (entry zeroed out).
    const isLive = listing.type_ !== 0
    const isEth = listing.currencyAddress.toLowerCase() === ETH_CURRENCY
    const status: "active" | "settled" =
      isLive && isEth ? "active" : "settled"

    const endTime = listing.startTime > 0n
      ? listing.startTime + listing.duration
      : 0n
    const currentBidder = listing.highestBidder !== ZERO_ADDRESS
      ? listing.highestBidder.toLowerCase()
      : null

    await sql`
      INSERT INTO tl_active_auctions
        (contract, token_id, seller, reserve_wei, current_bid_wei,
         current_bidder, end_time, listing_type, status,
         last_observed_block, updated_at)
      VALUES
        (${c.contract.toLowerCase()}, ${c.tokenId.toString()}, ${lower},
         ${listing.reservePrice.toString()}, ${listing.highestBid.toString()},
         ${currentBidder}, ${Number(endTime)}, ${listing.type_}, ${status},
         ${head.toString()}::bigint, NOW())
      ON CONFLICT (contract, token_id) DO UPDATE SET
        reserve_wei = EXCLUDED.reserve_wei,
        current_bid_wei = EXCLUDED.current_bid_wei,
        current_bidder = EXCLUDED.current_bidder,
        end_time = EXCLUDED.end_time,
        listing_type = EXCLUDED.listing_type,
        status = EXCLUDED.status,
        last_observed_block = EXCLUDED.last_observed_block,
        updated_at = NOW()
    `
    rowsWritten++
  }

  if (chunks > 0) await advanceCursor(scope, cursor - 1n)
  return { rpcCalls, rowsWritten }
}

async function advanceCursor(scope: string, lastBlock: bigint): Promise<void> {
  if (!sql) return
  await sql`
    INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
    VALUES (${TASK}, ${scope}, ${lastBlock.toString()}::bigint, NOW())
    ON CONFLICT (task, scope) DO UPDATE SET
      last_block = EXCLUDED.last_block, last_run_at = NOW()
  `
}
