/**
 * Foundation shared 1/1 scanner.
 *
 * The Foundation shared NFT contract (0x3B3ee19…) is ONE contract that
 * many artists mint 1/1s on. Unlike the per-artist platforms
 * (manifold/mint/tl), there's no per-artist clone to scan — there's one
 * shared contract, and we filter its Minted events down to creators in
 * `known_artists`.
 *
 * Why this lives in the worker and not Ponder: Ponder *could* index this
 * contract, but doing so means indexing EVERY Foundation 1/1 mint by
 * everyone (a multi-year, high-volume backfill), and the existing Ponder
 * config had its start block wrong anyway (pointed at the 2025 PND
 * factory block, so it caught nothing). Scanning it here, scoped to
 * known_artists, keeps spend bounded by artist count like every other
 * per-artist platform. See ARCHITECTURE.md.
 *
 * Writes to `public.artist_tokens` with platform='fnd-shared'. The web's
 * discoverArtistTokenRefs already UNIONs artist_tokens, so these surface
 * on artist pages with no further wiring. Owner is resolved inline;
 * transfer history is intentionally skipped (scan-token-transfers
 * excludes shared platforms — scanning every transfer on the shared
 * contract would be the exact unbounded scan we're avoiding).
 *
 * The Minted event's `creator` is an indexed topic, but we fetch all
 * Minted events per block-chunk (one getLogs call) and filter by
 * known_artists in code rather than passing a 155-address topic-OR
 * filter — fewer calls, and avoids provider-specific topic-array size
 * limits.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import { resolveNewTokenOwner } from "../scanners/resolve-owner.ts"
import { parseAbiItem, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"

const FOUNDATION_NFT = "0x3b3ee1931dc30c1957379fac9aba94d1c48a5405"
// FoundationNFT shared contract deploy (~Jan 2021). A slightly-early
// floor just means a few empty leading chunks; harmless.
const FND_NFT_DEPLOY_BLOCK = 11_648_000n
const CHUNK_SIZE = 9_500n // drpc free-tier eth_getLogs cap
const MAX_CHUNKS_PER_TICK = 50n
const TASK = "scan-fnd-shared"
const SCOPE = "fnd-shared"

const mintedEvent = parseAbiItem(
  "event Minted(address indexed creator, uint256 indexed tokenId, string indexed indexedTokenIPFSPath, string tokenIPFSPath)",
)

export async function scanFndShared(): Promise<TaskResult> {
  if (!sql) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const artistRows = (await sql`
    SELECT address FROM known_artists
  `) as Array<{ address: string }>
  const knownArtists = new Set(artistRows.map((r) => r.address.toLowerCase()))
  if (knownArtists.size === 0) {
    return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  }

  // Historical backfill from the frozen seed (migration 023). The chunk
  // sweep below filters Minted events by known_artists AT SCAN TIME, so
  // an artist admitted after the cursor passed their mint blocks would
  // never get their historical shared 1/1s. This pure-SQL copy (zero
  // RPC, idempotent per tick) heals that for every admission path.
  let seededRows = 0
  try {
    const seeded = await sql`
      INSERT INTO artist_tokens
        (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
      SELECT s.creator, ${FOUNDATION_NFT}, s.token_id, 'fnd-shared',
             s.mint_block, s.mint_log_index, NOW()
      FROM fnd_shared_mints_seed s
      JOIN known_artists k ON k.address = s.creator
      ON CONFLICT (contract, token_id) DO NOTHING
    `
    seededRows = seeded.count ?? 0
    if (seededRows > 0) {
      console.log(`[${TASK}] seeded ${seededRows} historical shared mints`)
    }
  } catch (err) {
    // Seed table may not exist yet on an un-migrated environment —
    // the live sweep still runs.
    console.error(`[${TASK}] seed copy failed:`, err)
  }

  const head = await client.getBlockNumber()
  let rpcCalls = 1

  const cursorRow = (await sql`
    SELECT last_block::text AS last_block FROM worker_cursors
    WHERE task = ${TASK} AND scope = ${SCOPE} LIMIT 1
  `) as Array<{ last_block: string }>
  let cursor = cursorRow[0]
    ? BigInt(cursorRow[0].last_block) + 1n
    : FND_NFT_DEPLOY_BLOCK

  let rowsWritten = 0
  let chunks = 0n
  while (cursor <= head && chunks < MAX_CHUNKS_PER_TICK) {
    const toBlock =
      cursor + CHUNK_SIZE - 1n > head ? head : cursor + CHUNK_SIZE - 1n

    await throttleRpc()
    let logs: Awaited<
      ReturnType<typeof client.getLogs<typeof mintedEvent>>
    > = []
    try {
      logs = await client.getLogs({
        address: FOUNDATION_NFT as Address,
        event: mintedEvent,
        fromBlock: cursor,
        toBlock,
      })
    } catch (err) {
      console.error(`[${TASK}] getLogs ${cursor}-${toBlock}:`, err)
    }
    rpcCalls += 1

    for (const log of logs) {
      const creator = log.args.creator?.toLowerCase()
      if (!creator || !knownArtists.has(creator)) continue
      if (log.args.tokenId === undefined) continue
      const tokenId = log.args.tokenId.toString()
      await sql`
        INSERT INTO artist_tokens
          (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
        VALUES
          (${creator}, ${FOUNDATION_NFT}, ${tokenId}, 'fnd-shared',
           ${log.blockNumber!.toString()}::bigint, ${log.logIndex!}, NOW())
        ON CONFLICT (contract, token_id) DO NOTHING
      `
      rowsWritten += 1
      await resolveNewTokenOwner({
        sql,
        client,
        contract: FOUNDATION_NFT,
        tokenId,
      }).catch(() => undefined)
    }

    cursor = toBlock + 1n
    await sql`
      INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
      VALUES (${TASK}, ${SCOPE}, ${(cursor - 1n).toString()}::bigint, NOW())
      ON CONFLICT (task, scope) DO UPDATE SET
        last_block = EXCLUDED.last_block, last_run_at = NOW()
    `
    chunks += 1n
  }

  return {
    scopeCount: knownArtists.size,
    rpcCalls,
    rowsWritten: rowsWritten + seededRows,
  }
}
