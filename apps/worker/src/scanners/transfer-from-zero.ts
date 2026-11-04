/**
 * Generic incremental ERC-721 Transfer-from-zero scanner. Used by
 * FND-collection, TL-clone, and (potentially future) per-artist
 * contracts that share the "Transfer with from=0x0 is a mint" pattern.
 *
 * For each (task, contract) pair, the cursor in `worker_cursors` tracks
 * the last-scanned block. First scan covers `contractDeployBlock → safe
 * head` in chunks of MAX_BLOCKS_PER_SCAN. Subsequent scans cover
 * `cursor + 1 - overlap → safe head` (finality.ts, cursors.ts); the
 * inserts are ON CONFLICT DO NOTHING, so the replayed overlap is free of
 * side effects.
 *
 * The walk goes through scan-range (a failing range is split and never
 * recorded as scanned). The error, if any, is RETURNED rather than
 * thrown so the caller can surface it in TaskResult.errors; with a
 * `backoff` context a failing scope is skipped for an exponentially
 * growing time instead of every tick (backoff.ts).
 *
 * Discovered mints upsert into `artist_tokens`. The companion
 * `resolveNewTokenOwner` helper writes an immediate `token_owners` row
 * so /collector/[address] never sees a null-owner window.
 */
import type { Sql } from "postgres"
import {
  parseAbiItem, getAddress, type Address, type PublicClient,
} from "viem"
import { resolveNewTokenOwner } from "./resolve-owner.ts"
import { throttleRpc } from "../throttle.ts"
import { scanRange } from "../scan-range.ts"
import { assertLogsInRange } from "../log-guard.ts"
import { advanceCursor, readCursor, scanWindow } from "../cursors.ts"
import { replayOverlap, type SafeHeadReader } from "../finality.ts"
import { withBackoff, type BackoffContext } from "../backoff.ts"

const TRANSFER_FROM_ZERO = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
const ZERO = "0x0000000000000000000000000000000000000000"
// drpc free tier caps eth_getLogs at 10,000 blocks per call. Stay under
// with margin. Per-tick chunk budget kept low so each cycle leaves
// budget for other tasks; backfill spread across many cycles is fine.
const MAX_BLOCKS_PER_SCAN = 9_500n
const MAX_ITERATIONS_PER_CALL = 15

export type ScanArgs = {
  // postgres.js Sql instance — typed loosely because the library's
  // generic surface is heavy and we only use template-tag + unsafe.
  sql: Sql
  client: PublicClient
  safeHead: SafeHeadReader
  taskName: string
  platform: string
  artist: string
  contract: string
  contractDeployBlock: bigint
  /** Scheduled tasks pass their backoff rows; refresh-artist omits it. */
  backoff?: BackoffContext
}

export type ScanResult = {
  rpcCalls: number
  rowsWritten: number
  /** Why the scan stopped short, or null. The cursor is held there. */
  error: string | null
  /** True when the scope was skipped because it is backed off. */
  skipped?: boolean
}

export async function scanArtistTokensViaTransferFromZero(
  args: ScanArgs,
): Promise<ScanResult> {
  const { sql, taskName, artist, contract } = args
  const scope = `${artist}:${contract}`
  const r = await withBackoff(sql, taskName, scope, args.backoff, () => scanScope(args, scope))
  return "skipped" in r ? { rpcCalls: 0, rowsWritten: 0, error: null, skipped: true } : r
}

async function scanScope(args: ScanArgs, scope: string): Promise<ScanResult> {
  const { sql, client, taskName, platform, artist, contract, contractDeployBlock } = args

  const head = await args.safeHead.get()
  let rpcCalls = head.rpcCalls
  let rowsWritten = 0

  const window = scanWindow({
    cursor: await readCursor(sql, taskName, scope),
    initialFrom: contractDeployBlock,
    safeHead: head.block,
    overlap: replayOverlap(),
  })
  if (!window) return { rpcCalls, rowsWritten, error: null }

  const scan = await scanRange({
    from: window.from,
    to: window.to,
    chunkSize: MAX_BLOCKS_PER_SCAN,
    maxChunks: MAX_ITERATIONS_PER_CALL,
    label: `${taskName} ${scope}`,
    fetch: async (a, b) => {
      await throttleRpc()
      const logs = await client.getLogs({
        address: getAddress(contract) as Address,
        event: TRANSFER_FROM_ZERO,
        args: { from: ZERO as `0x${string}`, to: getAddress(artist) as Address },
        fromBlock: a,
        toBlock: b,
      })
      return assertLogsInRange(logs, a, b, `${taskName} ${scope}`)
    },
    process: async (logs) => {
      for (const log of logs) {
        // tokenId 0 is a real token (L1): test for undefined, not falsiness.
        if (log.args.tokenId === undefined) continue
        const tokenId = log.args.tokenId.toString()

        const inserted = await sql`
          INSERT INTO artist_tokens
            (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
          VALUES
            (${artist}, ${contract}, ${tokenId}, ${platform},
             ${log.blockNumber.toString()}::bigint, ${log.logIndex}, NOW())
          ON CONFLICT (contract, token_id) DO NOTHING
        `
        if (inserted.count === 0) continue // already known (replayed overlap)
        rowsWritten += inserted.count

        // Event-triggered single ownerOf — populates token_owners
        // immediately so /collector/[address] never sees a null window.
        await resolveNewTokenOwner({ sql, client, contract, tokenId })
        rpcCalls += 1
      }
    },
    commit: (scannedTo) => advanceCursor(sql, taskName, scope, scannedTo),
    onSplit: (a, b, err) =>
      console.warn(`[${taskName}] ${scope} getLogs ${a}-${b} failed, splitting: ${err}`),
  })
  rpcCalls += scan.calls

  if (scan.error) {
    console.error(`[${taskName}] ${scope}: stopped at a failing range, cursor held at ${scan.scannedTo}:`, scan.error.message)
  }
  return { rpcCalls, rowsWritten, error: scan.error ? scan.error.message : null }
}
