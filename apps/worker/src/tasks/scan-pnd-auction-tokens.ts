/**
 * Index tokens that are sold through PND/sovereign auctions but live on
 * contracts outside our pre-defined platform list (Foundation / SuperRare /
 * Mint / TL / Manifold).
 *
 * The gap this closes: an artist deploys their own ERC-721 and lists a piece
 * on their Sovereign Auction House. Ponder indexes the auction
 * (`pnd_auctions`), so the auction panel renders — but no per-platform
 * scanner ever touches that arbitrary contract, so `artist_tokens` /
 * `token_owners` / `token_metadata` stay empty and the token page shows no
 * artist tag, owner, provenance, or image.
 *
 * Fix: treat "appears as `token_contract` in `pnd_auctions`" as the index
 * signal. For each such (contract, token) not yet in `artist_tokens`, find
 * its mint — `Transfer(0x0 -> recipient, tokenId)` — and record the mint
 * RECIPIENT as the creator (the correct signal; the auction *seller* is just
 * whoever listed it and is NOT necessarily the artist).
 *
 * Attribution guard (option B): only write the artist when the mint
 * recipient lines up with reality — it equals one of the token's auction
 * sellers, or it's already a known artist. If a contract minted to some
 * third party we can't corroborate, we skip rather than assert a wrong
 * creator. The common case (artist mints to self, then lists) lines up and
 * is attributed; once a row lands, the existing machinery
 * (`scan-token-transfers`, `warm-metadata`, `resolveNewTokenOwner`) fills
 * owner / provenance / image with no further wiring.
 *
 * Bounded by design: only contracts with a PND auction are ever scanned
 * (never the open chain), the mint lookup is tokenId-topic-filtered, and we
 * stop as soon as the mint is found.
 *
 * Negative cache (audit M3, #295): a token whose mint can't be found in
 * the lookback window, or whose mint recipient can't be corroborated,
 * gives the same answer next tick. It used to be re-walked every 15
 * minutes (up to 50 getLogs each, no ORDER BY), so the same unresolvable
 * tokens ate the per-tick budget and starved the rest of the queue. Now
 * each outcome is remembered in scan_backoff (scope `contract:tokenId`)
 * with an exponentially growing retry delay, backed-off tokens are left
 * out of the query, and the queue is walked in a deterministic order
 * (fewest failures first, then oldest auction). A getLogs failure stops
 * that token's walk (it used to carry on past the failed chunk as if it
 * had no logs, and could then give up on a mint it never looked at) and
 * backs off on a shorter schedule.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import { resolveNewTokenOwner } from "../scanners/resolve-owner.ts"
import { parseAbiItem, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"
import { assertLogsInRange } from "../log-guard.ts"
import { describeScanError } from "../scan-range.ts"
import {
  clearBackoff, loadBackoff, recordFailure, type BackoffPolicy, type BackoffRow,
} from "../backoff.ts"

const ZERO = "0x0000000000000000000000000000000000000000"
// Shared 1/1 contracts are excluded: they're high-volume and their creators
// already come from Ponder's fnd_/srv2_ artist-token tables. A from-zero
// scan of these would be the exact unbounded scan v2 avoids.
const SHARED_CONTRACTS = [
  "0x3b3ee1931dc30c1957379fac9aba94d1c48a5405", // Foundation shared NFT
  "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0", // SuperRare shared NFT
]
const CHUNK = 9_500n // drpc free-tier eth_getLogs cap
const MAX_LOOKBACK_CHUNKS = 50n // mints sit shortly before the listing
const MAX_RPC_PER_TICK = 300 // wall-time guard; resumes next tick
const TASK = "scan-pnd-auction-tokens"
const INTERVAL_MS = 15 * 60_000
// "Not found" / "not corroborated" are deterministic answers: retry
// rarely (30m, 1h, 2h, ... capped at a week) in case a new auction
// seller or a newly known artist changes the attribution verdict.
const NEGATIVE: BackoffPolicy = { baseMs: INTERVAL_MS, maxMs: 7 * 24 * 60 * 60_000 }
// RPC failures are transient: same doubling, capped at 6 hours.
const TRANSIENT: BackoffPolicy = { baseMs: INTERVAL_MS, maxMs: 6 * 60 * 60_000 }

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)

type Needed = {
  contract: string
  token_id: string
  sellers: string[]
  anchor: string // earliest auction created_at_block
}

type Walk =
  | { kind: "found"; to: string; block: bigint; logIndex: number }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "budget" }

export async function scanPndAuctionTokens(): Promise<TaskResult> {
  if (!sql) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const artistRows = (await sql`SELECT address FROM known_artists`) as Array<{
    address: string
  }>
  const knownArtists = new Set(artistRows.map((r) => r.address.toLowerCase()))

  // Tokens auctioned on non-shared contracts that we haven't indexed yet,
  // minus those in their negative-cache window, in a stable order.
  const needed = (await sql.unsafe(
    `SELECT n.contract, n.token_id, n.sellers, n.anchor
       FROM (
         SELECT lower(a.token_contract) AS contract,
                a.token_id::text       AS token_id,
                array_agg(DISTINCT lower(a.seller)) AS sellers,
                MIN(a.created_at_block)::text       AS anchor
           FROM ${INDEXER_SCHEMA}.pnd_auctions a
          WHERE lower(a.token_contract) <> ALL($1::text[])
            AND NOT EXISTS (
              SELECT 1 FROM artist_tokens t
               WHERE t.contract = lower(a.token_contract)
                 AND t.token_id = a.token_id::text
            )
          GROUP BY 1, 2
       ) n
       LEFT JOIN scan_backoff b
         ON b.task = $2 AND b.scope = n.contract || ':' || n.token_id
      WHERE b.retry_at IS NULL OR b.retry_at <= NOW()
      ORDER BY COALESCE(b.failures, 0), n.anchor::numeric, n.contract, n.token_id`,
    [SHARED_CONTRACTS, TASK],
  )) as Needed[]
  const backoff = await loadBackoff(sql, TASK)

  let rpcCalls = 0
  let rowsWritten = 0
  const errors: string[] = []
  const contracts = new Set(needed.map((n) => n.contract))

  const remember = async (
    prev: BackoffRow | undefined, scope: string, reason: string, policy: BackoffPolicy,
  ) => {
    await recordFailure(sql, TASK, prev, scope, reason, policy).catch((err) => {
      console.error(`[${TASK}] could not record backoff for ${scope}:`, err)
    })
  }

  for (const n of needed) {
    if (rpcCalls >= MAX_RPC_PER_TICK) break
    const scope = `${n.contract}:${n.token_id}`
    const prev = backoff.get(scope)

    const walk = await findMint(n, () => rpcCalls, () => { rpcCalls += 1 })
    if (walk.kind === "budget") break
    if (walk.kind === "error") {
      errors.push(describeScanError(scope, walk.message))
      await remember(prev, scope, walk.message, TRANSIENT)
      continue
    }
    if (walk.kind === "not-found") {
      await remember(prev, scope, `no mint within ${MAX_LOOKBACK_CHUNKS} chunks before block ${n.anchor}`, NEGATIVE)
      continue
    }

    // Attribution guard (option B): only credit a creator we can corroborate
    // against the auction seller(s) or the known-artist set.
    const mintTo = walk.to
    const linedUp = knownArtists.has(mintTo) || n.sellers.includes(mintTo)
    if (!linedUp) {
      const reason =
        `mint recipient ${mintTo} is neither a seller (${n.sellers.join(",")}) nor a known artist`
      console.warn(`[${TASK}] skip ${scope}: ${reason}`)
      await remember(prev, scope, reason, NEGATIVE)
      continue
    }

    const inserted = await sql`
      INSERT INTO artist_tokens
        (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
      VALUES
        (${mintTo}, ${n.contract}, ${n.token_id}, 'sovereign',
         ${walk.block.toString()}::bigint, ${walk.logIndex}, NOW())
      ON CONFLICT (contract, token_id) DO NOTHING
    `
    rowsWritten += inserted.count
    if (prev) await clearBackoff(sql, TASK, [scope]).catch(() => undefined)
    await resolveNewTokenOwner({
      sql,
      client,
      contract: n.contract,
      tokenId: n.token_id,
    }).catch(() => undefined)
  }

  return { scopeCount: contracts.size, rpcCalls, rowsWritten, errors }
}

/**
 * Walk backward from the listing block in getLogs-sized chunks until the
 * mint (it must precede the auction). tokenId is an indexed topic, so
 * each call is a precise point lookup. Stops on the first failed call:
 * a chunk that wasn't read can't be treated as "no mint here".
 */
async function findMint(
  n: Needed, spent: () => number, charge: () => void,
): Promise<Walk> {
  const tokenId = BigInt(n.token_id)
  let toBlock = BigInt(n.anchor)
  for (let i = 0n; i < MAX_LOOKBACK_CHUNKS && toBlock > 0n; i++) {
    if (spent() >= MAX_RPC_PER_TICK) return { kind: "budget" }
    const fromBlock = toBlock > CHUNK ? toBlock - CHUNK + 1n : 0n
    await throttleRpc()
    charge()
    try {
      const logs = assertLogsInRange(await client.getLogs({
        address: n.contract as Address,
        event: transferEvent,
        args: { from: ZERO as Address, tokenId },
        fromBlock,
        toBlock,
      }), fromBlock, toBlock, `${TASK} ${n.contract}`)
      if (logs.length > 0) {
        const log = logs[0]
        const to = log.args.to?.toLowerCase()
        if (!to) return { kind: "not-found" }
        return { kind: "found", to, block: log.blockNumber, logIndex: log.logIndex }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err)
      console.error(`[${TASK}] getLogs ${n.contract} ${fromBlock}-${toBlock}: ${message}`)
      return { kind: "error", message: `getLogs ${fromBlock}-${toBlock}: ${message}` }
    }
    toBlock = fromBlock - 1n
  }
  return { kind: "not-found" }
}
