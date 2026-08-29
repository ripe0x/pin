/**
 * Global SuperRare Bazaar tracker. The marketplace is one fixed contract, so
 * scanning it once and filtering creators in Postgres is both cheaper and more
 * complete than repeating the same block ranges for every known artist.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { getFinalizedBoundary } from "../finality.ts"
import { throttleRpc } from "../throttle.ts"
import { getAddress, parseAbiItem, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"

const SR_BAZAAR = "0x6d7c44773c52d396f43c2d511b81aa168e9a7a42" as const
const SR_BAZAAR_DEPLOY_BLOCK = 14_100_000n
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
const CHUNK_SIZE = 9_500n
const MAX_CHUNKS_PER_TICK = 50
const TASK = "scan-srv2-active-auctions"
const SCOPE = "global"

const newAuctionEvent = parseAbiItem(
  "event NewAuction(address indexed _contractAddress, uint256 indexed _tokenId, address indexed _auctionCreator, address _currencyAddress, uint256 _startingTime, uint256 _minimumBid, uint256 _lengthOfAuction)",
)

const tokenAuctionsAbi = [{
  type: "function", name: "tokenAuctions", stateMutability: "view",
  inputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }],
  outputs: [
    { name: "auctionCreator", type: "address" },
    { name: "creationBlock", type: "uint256" },
    { name: "startingTime", type: "uint256" },
    { name: "lengthOfAuction", type: "uint256" },
    { name: "currencyAddress", type: "address" },
    { name: "minimumBid", type: "uint256" },
    { name: "auctionType", type: "bytes32" },
  ],
}] as const

const auctionBidsAbi = [{
  type: "function", name: "auctionBids", stateMutability: "view",
  inputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }],
  outputs: [
    { name: "bidder", type: "address" },
    { name: "currencyAddress", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "marketplaceFee", type: "uint8" },
  ],
}] as const

type Candidate = {
  contract: Address
  tokenId: bigint
  seller: string
  reserveWei: bigint
}

export async function scanSrv2ActiveAuctions(): Promise<TaskResult> {
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
    : SR_BAZAAR_DEPLOY_BLOCK
  if (cursor > head) return { scopeCount: 1, rpcCalls, rowsWritten: 0 }

  const candidates = new Map<string, Candidate>()
  let chunks = 0
  while (cursor <= head && chunks < MAX_CHUNKS_PER_TICK) {
    const toBlock = cursor + CHUNK_SIZE - 1n > head ? head : cursor + CHUNK_SIZE - 1n
    await throttleRpc()
    const logs = await client.getLogs({
      address: SR_BAZAAR,
      event: newAuctionEvent,
      fromBlock: cursor,
      toBlock,
    })
    rpcCalls += 1
    for (const log of logs) {
      const seller = log.args._auctionCreator?.toLowerCase()
      const contract = log.args._contractAddress
      const tokenId = log.args._tokenId
      if (!seller || !knownArtists.has(seller) || !contract || tokenId === undefined) continue
      if (log.args._currencyAddress?.toLowerCase() !== ZERO_ADDRESS) continue
      candidates.set(`${contract.toLowerCase()}:${tokenId}`, {
        contract,
        tokenId,
        seller,
        reserveWei: log.args._minimumBid ?? 0n,
      })
    }
    cursor = toBlock + 1n
    chunks += 1
  }
  const scannedThrough = cursor - 1n

  // Once caught up, refresh every row still believed active. This retires
  // listings even when the artist has since left known_artists.
  if (scannedThrough === head) {
    const existing = (await sql`
      SELECT contract, token_id, seller, reserve_wei
      FROM srv2_active_auctions WHERE status = 'active'
    `) as Array<{ contract: string; token_id: string; seller: string; reserve_wei: string }>
    for (const row of existing) {
      const key = `${row.contract.toLowerCase()}:${row.token_id}`
      if (!candidates.has(key)) {
        candidates.set(key, {
          contract: getAddress(row.contract),
          tokenId: BigInt(row.token_id),
          seller: row.seller.toLowerCase(),
          reserveWei: BigInt(row.reserve_wei),
        })
      }
    }
  }

  const list = [...candidates.values()]
  const calls = list.flatMap((candidate) => [
    {
      address: SR_BAZAAR, abi: tokenAuctionsAbi,
      functionName: "tokenAuctions" as const,
      args: [candidate.contract, candidate.tokenId] as const,
    },
    {
      address: SR_BAZAAR, abi: auctionBidsAbi,
      functionName: "auctionBids" as const,
      args: [candidate.contract, candidate.tokenId] as const,
    },
  ])

  const results = calls.length === 0 ? [] : await client.multicall({
    contracts: calls,
    allowFailure: true,
    blockNumber: head,
  })
  if (calls.length > 0) rpcCalls += Math.max(1, Math.ceil(calls.length / 250))
  const failed = results.findIndex((result) => result.status === "failure")
  if (failed !== -1) {
    throw new Error(`SR listing multicall failed at result ${failed}; cursor unchanged`)
  }

  let rowsWritten = 0
  await sql.begin(async (tx) => {
    for (let index = 0; index < list.length; index++) {
      const candidate = list[index]
      const auction = results[index * 2]!.result as readonly [
        string, bigint, bigint, bigint, string, bigint, `0x${string}`,
      ]
      const bid = results[index * 2 + 1]!.result as readonly [string, string, bigint, number]
      const [creator, , startingTime, duration, currency, minimumBid] = auction
      const [bidder, , bidAmount] = bid
      const active = creator.toLowerCase() !== ZERO_ADDRESS && currency.toLowerCase() === ZERO_ADDRESS
      const seller = active ? creator.toLowerCase() : candidate.seller
      const changed = await tx`
        INSERT INTO srv2_active_auctions
          (contract, token_id, seller, reserve_wei, current_bid_wei,
           current_bidder, end_time, status, last_observed_block, updated_at)
        VALUES
          (${candidate.contract.toLowerCase()}, ${candidate.tokenId.toString()}, ${seller},
           ${(active ? minimumBid : candidate.reserveWei).toString()}, ${bidAmount.toString()},
           ${bidder.toLowerCase() === ZERO_ADDRESS ? null : bidder.toLowerCase()},
           ${Number(startingTime > 0n ? startingTime + duration : 0n)},
           ${active ? "active" : "settled"}, ${head.toString()}::bigint, NOW())
        ON CONFLICT (contract, token_id) DO UPDATE SET
          seller = EXCLUDED.seller,
          reserve_wei = EXCLUDED.reserve_wei,
          current_bid_wei = EXCLUDED.current_bid_wei,
          current_bidder = EXCLUDED.current_bidder,
          end_time = EXCLUDED.end_time,
          status = EXCLUDED.status,
          last_observed_block = EXCLUDED.last_observed_block,
          updated_at = NOW()
        WHERE (srv2_active_auctions.seller, srv2_active_auctions.reserve_wei,
               srv2_active_auctions.current_bid_wei, srv2_active_auctions.current_bidder,
               srv2_active_auctions.end_time, srv2_active_auctions.status)
          IS DISTINCT FROM
              (EXCLUDED.seller, EXCLUDED.reserve_wei, EXCLUDED.current_bid_wei,
               EXCLUDED.current_bidder, EXCLUDED.end_time, EXCLUDED.status)
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
