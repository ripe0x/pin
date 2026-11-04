/**
 * Per-artist SR V2 Bazaar active-auction tracker. Writes to
 * `srv2_active_auctions` so the web app reads pure Postgres for the
 * artist gallery's auction overlay — no chunked getLogs on request.
 *
 * Flow per artist (gated on isKnownArtist):
 *   1. Read cursor from worker_cursors for scope=`srv2:<artist>`.
 *      First-run = SR_BAZAAR_DEPLOY_BLOCK.
 *   2. Chunked `eth_getLogs(NewAuction, _auctionCreator=artist)` in
 *      10K-block windows (drpc free tier cap) from cursor → head.
 *      Each candidate is (contract, tokenId, reserveWei).
 *   3. Multicall `tokenAuctions(contract, tokenId)` for every candidate
 *      (new + already-tracked-as-active in the table) to refresh live
 *      state. Entries that return zero creator are flipped to status
 *      'settled' (the storage entry got deleted on settle/cancel).
 *   4. Multicall `auctionBids(contract, tokenId)` for every still-active
 *      to read current bid amount.
 *   5. UPSERT into `srv2_active_auctions` with the merged state.
 *   6. Advance cursor, but only through ranges whose getLogs succeeded
 *      (scan-range.ts) and never past the log of a NEW candidate whose
 *      state read failed, so a failed multicall leg is retried next
 *      tick instead of silently dropping that auction.
 *
 * Cadence: every 5 min. Page-load freshness: up to 5 min stale, which
 * is acceptable because the bid button reads fresh chain state at
 * click-time and the contract rejects stale bids regardless of UI.
 */
import { sql } from "../db.ts"
import { client, safeHead } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import {
  getAddress, parseAbiItem, type Address,
} from "viem"
import type { TaskResult } from "../scheduler.ts"
import { describeScanError, scanRange } from "../scan-range.ts"
import { assertLogsInRange } from "../log-guard.ts"
import { advanceCursor as upsertCursor, readCursor, scanWindow } from "../cursors.ts"
import { replayOverlap } from "../finality.ts"

const SR_BAZAAR = "0x6d7c44773c52d396f43c2d511b81aa168e9a7a42" as const
const SR_BAZAAR_DEPLOY_BLOCK = 14_100_000n
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
const ETH_CURRENCY = ZERO_ADDRESS
const CHUNK_SIZE = 10_000n
const MAX_CHUNKS_PER_TICK = 50 // cap per-task wall time; cursor advances next tick

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

const TASK = "scan-srv2-active-auctions"

export async function scanSrv2ActiveAuctions(): Promise<TaskResult> {
  if (!sql) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const artists = (await sql`
    SELECT address FROM known_artists
  `) as Array<{ address: string }>

  if (artists.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  // Confirmations-mode safe head (finality.ts): latest - SCAN_CONFIRMATIONS.
  // Not `finalized`: every candidate's state is re-read live below and
  // an orphaned listing log reads back as settled, so this tracker only
  // needs the margin against lagging providers, and the gallery overlay
  // stays ~2 min behind the tip instead of ~15.
  const safe = await safeHead.get("confirmed")
  const head = safe.block
  let rpcCalls = safe.rpcCalls
  let rowsWritten = 0
  const errors: string[] = []

  for (const { address } of artists) {
    try {
      const r = await scanOneArtist(address, head)
      rpcCalls += r.rpcCalls
      rowsWritten += r.rowsWritten
      errors.push(...r.errors)
    } catch (err) {
      console.error(`[${TASK}] ${address}:`, err)
      errors.push(describeScanError(address, err))
    }
  }

  return { scopeCount: artists.length, rpcCalls, rowsWritten, errors }
}

async function scanOneArtist(
  artist: string, head: bigint,
): Promise<{ rpcCalls: number; rowsWritten: number; errors: string[] }> {
  if (!sql) return { rpcCalls: 0, rowsWritten: 0, errors: [] }
  const lower = artist.toLowerCase()
  const scope = `srv2:${lower}`

  // Cursor: scan from this block forward.
  // Replays a small overlap below the cursor: candidates are keyed on
  // (contract, tokenId) and their rows are upserts from live state, so
  // re-reading a log is harmless. Nothing new: skip the walk but still
  // re-check tracked rows below.
  const window = scanWindow({
    cursor: await readCursor(sql, TASK, scope),
    initialFrom: SR_BAZAAR_DEPLOY_BLOCK,
    safeHead: head,
    overlap: replayOverlap(),
  })
  const fromBlock = window ? window.from : head + 1n

  let rpcCalls = 0
  const errors: string[] = []

  // 1. Walk forward in 10K chunks, collecting new NewAuction candidates.
  //    `block` is the block of the log that introduced a NEW candidate
  //    (null for rows re-checked from the table): if its state read
  //    fails below, the cursor must not pass that block, or the auction
  //    is never seen again.
  const candidates = new Map<string, {
    contract: Address; tokenId: bigint; reserveWei: bigint; block: bigint | null
  }>()
  const scan = await scanRange({
    from: fromBlock,
    to: head,
    chunkSize: CHUNK_SIZE,
    maxChunks: MAX_CHUNKS_PER_TICK,
    label: `${TASK} ${scope}`,
    fetch: async (a, b) => {
      await throttleRpc()
      const logs = await client.getLogs({
        address: SR_BAZAAR,
        event: newAuctionEvent,
        args: { _auctionCreator: getAddress(lower) as Address },
        fromBlock: a,
        toBlock: b,
      })
      return assertLogsInRange(logs, a, b, `${TASK} ${scope}`)
    },
    process: (logs) => {
      for (const l of logs) {
        const c = l.args._contractAddress as Address
        const t = l.args._tokenId as bigint
        // Filter non-ETH at the event level: skip currencyAddress != 0x0.
        if (
          l.args._currencyAddress &&
          l.args._currencyAddress.toLowerCase() !== ETH_CURRENCY
        ) continue
        candidates.set(`${c.toLowerCase()}:${t.toString()}`, {
          contract: c,
          tokenId: t,
          reserveWei: l.args._minimumBid ?? 0n,
          block: l.blockNumber ?? null,
        })
      }
    },
  })
  rpcCalls += scan.calls
  if (scan.error) errors.push(describeScanError(scope, scan.error))
  // Last block whose logs were all fetched; may be lowered below if a
  // new candidate's state read fails.
  let safeTo = scan.scannedTo

  // 2. Also re-check rows we previously marked active (state may have
  //    changed since last scan even if no new NewAuction landed).
  const existing = (await sql`
    SELECT contract, token_id FROM srv2_active_auctions
    WHERE seller = ${lower} AND status = 'active'
  `) as Array<{ contract: string; token_id: string }>
  for (const e of existing) {
    const key = `${e.contract.toLowerCase()}:${e.token_id}`
    if (!candidates.has(key)) {
      candidates.set(key, {
        contract: getAddress(e.contract) as Address,
        tokenId: BigInt(e.token_id),
        reserveWei: 0n, // unknown without re-fetching the event; refresh below
        block: null,
      })
    }
  }

  if (candidates.size === 0) {
    // Still advance the cursor so we don't re-scan the same range.
    if (safeTo >= fromBlock) await advanceCursor(scope, safeTo)
    return { rpcCalls, rowsWritten: 0, errors }
  }

  // 3. Multicall tokenAuctions + auctionBids for every candidate.
  const list = Array.from(candidates.values())
  const calls = list.flatMap((c) => [
    {
      address: SR_BAZAAR, abi: tokenAuctionsAbi,
      functionName: "tokenAuctions" as const,
      args: [c.contract, c.tokenId] as const,
    },
    {
      address: SR_BAZAAR, abi: auctionBidsAbi,
      functionName: "auctionBids" as const,
      args: [c.contract, c.tokenId] as const,
    },
  ])
  const results = (await client.multicall({
    contracts: calls,
    allowFailure: true,
  })) as Array<{ status: "success"; result: unknown } | { status: "failure" }>
  rpcCalls += Math.ceil(calls.length / 250) // multicall3 batches; rough estimate

  let rowsWritten = 0
  let failedLegs = 0
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    const aRes = results[i * 2]
    const bRes = results[i * 2 + 1]
    if (aRes.status !== "success" || bRes.status !== "success") {
      // A new auction isn't in the table yet, so skipping it while the
      // cursor moves past its NewAuction log would lose it for good.
      // Hold the cursor just before that log; the next tick re-reads it.
      // (A row already tracked as active is re-checked every tick from
      // the table, so it doesn't constrain the cursor.)
      failedLegs++
      if (c.block !== null && c.block - 1n < safeTo) safeTo = c.block - 1n
      continue
    }
    const auction = aRes.result as readonly [
      string, bigint, bigint, bigint, string, bigint, `0x${string}`,
    ]
    const [creator, , startingTime, lengthOfAuction, currency, minimumBid] = auction
    const bid = bRes.result as readonly [string, string, bigint, number]
    const [bidder, , bidAmount] = bid

    // Status transitions: creator zero = entry deleted on settle/cancel.
    const isLive = creator !== ZERO_ADDRESS
    const isEth = currency.toLowerCase() === ETH_CURRENCY
    const status: "active" | "settled" =
      isLive && isEth ? "active" : "settled"

    const endTime = startingTime > 0n ? startingTime + lengthOfAuction : 0n
    const currentBidder = bidder !== ZERO_ADDRESS ? bidder.toLowerCase() : null
    const reserveWei = isLive ? minimumBid : c.reserveWei

    await sql`
      INSERT INTO srv2_active_auctions
        (contract, token_id, seller, reserve_wei, current_bid_wei,
         current_bidder, end_time, status, last_observed_block, updated_at)
      VALUES
        (${c.contract.toLowerCase()}, ${c.tokenId.toString()},
         ${lower}, ${reserveWei.toString()}, ${bidAmount.toString()},
         ${currentBidder}, ${Number(endTime)}, ${status},
         ${head.toString()}::bigint, NOW())
      ON CONFLICT (contract, token_id) DO UPDATE SET
        reserve_wei = EXCLUDED.reserve_wei,
        current_bid_wei = EXCLUDED.current_bid_wei,
        current_bidder = EXCLUDED.current_bidder,
        end_time = EXCLUDED.end_time,
        status = EXCLUDED.status,
        last_observed_block = EXCLUDED.last_observed_block,
        updated_at = NOW()
    `
    rowsWritten++
  }

  if (failedLegs > 0) {
    errors.push(`${scope}: ${failedLegs} of ${list.length} auction state read(s) failed; cursor held at ${safeTo}`)
  }

  // Advance cursor to the last block we actually scanned via getLogs
  // (lowered to just before any new candidate whose state read failed).
  // If no getLogs range succeeded, don't touch the cursor — the
  // multicall refresh above doesn't extend it.
  if (safeTo >= fromBlock) {
    await advanceCursor(scope, safeTo)
  }

  return { rpcCalls, rowsWritten, errors }
}

async function advanceCursor(scope: string, lastBlock: bigint): Promise<void> {
  if (!sql) return
  // GREATEST upsert (cursors.ts): a cursor held below a failed leg, or a
  // replayed overlap, can never move an existing cursor backwards.
  await upsertCursor(sql, TASK, scope, lastBlock)
}
