/**
 * Generic incremental ERC-721 Transfer-from-zero scanner. Used by
 * FND-collection, TL-clone, and (potentially future) per-artist
 * contracts that share the "Transfer with from=0x0 is a mint" pattern.
 *
 * For each (task, contract) pair, the cursor in `worker_cursors` tracks
 * the last-scanned block. First scan covers `contractDeployBlock → head`
 * in chunks of MAX_BLOCKS_PER_SCAN. Subsequent scans cover
 * `cursor+1 → head`.
 *
 * Discovered mints upsert into `artist_tokens`. The finalized transfer
 * scanner materializes ownership from the same event stream; this scanner
 * deliberately avoids a per-token ownerOf call.
 */
import type { Sql } from "postgres"
import {
  parseAbiItem, getAddress, type Address, type PublicClient,
} from "viem"
import { throttleRpc } from "../throttle.ts"
import { getFinalizedBoundary } from "../finality.ts"

const TRANSFER_FROM_ZERO = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
const ZERO = "0x0000000000000000000000000000000000000000"
// drpc free tier caps eth_getLogs at 10,000 blocks per call. Stay under
// with margin. Per-tick iteration count kept low so each cycle leaves
// budget for other tasks; backfill spread across many cycles is fine.
const MAX_BLOCKS_PER_SCAN = 9_500n
const MAX_ITERATIONS_PER_CALL = 15

export type ScanArgs = {
  // postgres.js Sql instance — typed loosely because the library's
  // generic surface is heavy and we only use template-tag + unsafe.
  sql: Sql
  client: PublicClient
  taskName: string
  platform: string
  artist: string
  contract: string
  contractDeployBlock: bigint
  finalizedBlock?: bigint
}

export type ScanResult = {
  rpcCalls: number
  rowsWritten: number
}

export type ArtistTokenScanTarget = {
  artist: string
  contract: string
  contractDeployBlock: bigint
}

const ADDRESS_BATCH_SIZE = 75
const MAX_HISTORICAL_CONTRACTS_PER_TICK = 20

/**
 * Scan caught-up creator contracts in multi-address requests. Historical
 * contracts retain bounded individual lanes so one old deployment cannot
 * force every address batch to replay millions of blocks.
 */
export async function scanArtistTokenTargetsViaTransferFromZero(args: {
  sql: Sql
  client: PublicClient
  taskName: string
  platform: string
  targets: ArtistTokenScanTarget[]
  finalizedBlock: bigint
}): Promise<ScanResult> {
  const deduped = [...new Map(args.targets.map((target) => [
    `${target.artist.toLowerCase()}:${target.contract.toLowerCase()}`,
    {
      ...target,
      artist: target.artist.toLowerCase(),
      contract: target.contract.toLowerCase(),
    },
  ])).values()]
  if (deduped.length === 0) return { rpcCalls: 0, rowsWritten: 0 }

  const scopes = deduped.map((target) => `${target.artist}:${target.contract}`)
  const rows = (await args.sql`
    SELECT scope, last_block::text AS last_block
    FROM worker_cursors
    WHERE task = ${args.taskName} AND scope = ANY(${scopes}::text[])
  `) as Array<{ scope: string; last_block: string }>
  const cursors = new Map(rows.map((row) => [row.scope, BigInt(row.last_block)]))
  const states = deduped.map((target) => {
    const scope = `${target.artist}:${target.contract}`
    const lastBlock = cursors.get(scope) ?? null
    const nextBlock = lastBlock === null ? target.contractDeployBlock : lastBlock + 1n
    return { ...target, scope, nextBlock }
  }).sort((a, b) => a.nextBlock < b.nextBlock ? -1 : a.nextBlock > b.nextBlock ? 1 : 0)

  const historical = states.filter(
    (state) => args.finalizedBlock - state.nextBlock >= MAX_BLOCKS_PER_SCAN,
  )
  const caughtUp = states.filter(
    (state) => args.finalizedBlock - state.nextBlock < MAX_BLOCKS_PER_SCAN,
  )
  let rpcCalls = 0
  let rowsWritten = 0

  for (const state of historical.slice(0, MAX_HISTORICAL_CONTRACTS_PER_TICK)) {
    const result = await scanArtistTokensViaTransferFromZero({
      sql: args.sql,
      client: args.client,
      taskName: args.taskName,
      platform: args.platform,
      artist: state.artist,
      contract: state.contract,
      contractDeployBlock: state.contractDeployBlock,
      finalizedBlock: args.finalizedBlock,
    })
    rpcCalls += result.rpcCalls
    rowsWritten += result.rowsWritten
  }

  for (let offset = 0; offset < caughtUp.length; offset += ADDRESS_BATCH_SIZE) {
    const batch = caughtUp
      .slice(offset, offset + ADDRESS_BATCH_SIZE)
      .filter((state) => state.nextBlock <= args.finalizedBlock)
    if (batch.length === 0) continue
    const fromBlock = batch.reduce(
      (minimum, state) => state.nextBlock < minimum ? state.nextBlock : minimum,
      batch[0].nextBlock,
    )

    await throttleRpc()
    const logs = await args.client.getLogs({
      address: batch.map((state) => getAddress(state.contract) as Address),
      event: TRANSFER_FROM_ZERO,
      args: { from: ZERO as `0x${string}` },
      fromBlock,
      toBlock: args.finalizedBlock,
    })
    rpcCalls += 1
    const targetByContract = new Map(batch.map((state) => [state.contract, state]))

    await args.sql.begin(async (tx) => {
      for (const log of logs) {
        if (
          log.args.tokenId === undefined || log.blockNumber === null ||
          log.logIndex === null
        ) {
          throw new Error("mint Transfer log missing durable identity")
        }
        const target = targetByContract.get(log.address.toLowerCase())
        if (!target) throw new Error(`unexpected mint contract ${log.address}`)
        const inserted = await tx`
          INSERT INTO artist_tokens
            (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
          VALUES
            (${target.artist}, ${target.contract}, ${log.args.tokenId.toString()},
             ${args.platform}, ${log.blockNumber.toString()}::bigint,
             ${log.logIndex}, NOW())
          ON CONFLICT (contract, token_id) DO NOTHING
          RETURNING 1
        `
        rowsWritten += inserted.length
      }
      for (const state of batch) {
        await tx`
          INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
          VALUES
            (${args.taskName}, ${state.scope},
             ${args.finalizedBlock.toString()}::bigint, NOW())
          ON CONFLICT (task, scope) DO UPDATE SET
            last_block = GREATEST(worker_cursors.last_block, EXCLUDED.last_block),
            last_run_at = NOW()
        `
      }
    })
  }

  return { rpcCalls, rowsWritten }
}

export async function scanArtistTokensViaTransferFromZero(
  args: ScanArgs,
): Promise<ScanResult> {
  const {
    sql, client, taskName, platform, artist, contract, contractDeployBlock,
    finalizedBlock,
  } = args

  const scope = `${artist}:${contract}`
  const boundary = finalizedBlock === undefined
    ? await getFinalizedBoundary(client)
    : { blockNumber: finalizedBlock, rpcCalls: 0 }
  const head = boundary.blockNumber
  let rpcCalls = boundary.rpcCalls
  let rowsWritten = 0

  const cursorRow = (await sql`
    SELECT last_block::text AS last_block
    FROM worker_cursors WHERE task = ${taskName} AND scope = ${scope}
    LIMIT 1
  `) as Array<{ last_block: string }>

  let cursor = cursorRow[0]
    ? BigInt(cursorRow[0].last_block) + 1n
    : contractDeployBlock

  let iterations = 0
  while (cursor <= head && iterations < MAX_ITERATIONS_PER_CALL) {
    const toBlock = cursor + MAX_BLOCKS_PER_SCAN > head
      ? head
      : cursor + MAX_BLOCKS_PER_SCAN

    await throttleRpc()
    const logs = await client.getLogs({
      address: getAddress(contract) as Address,
      event: TRANSFER_FROM_ZERO,
      args: { from: ZERO as `0x${string}` },
      fromBlock: cursor,
      toBlock,
    })
    rpcCalls += 1

    await sql.begin(async (tx) => {
      for (const log of logs) {
        if (log.args.tokenId === undefined) continue
        const inserted = await tx`
          INSERT INTO artist_tokens
            (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
          VALUES
            (${artist}, ${contract}, ${log.args.tokenId.toString()}, ${platform},
             ${log.blockNumber!.toString()}::bigint, ${log.logIndex!}, NOW())
          ON CONFLICT (contract, token_id) DO NOTHING
          RETURNING 1
        `
        rowsWritten += inserted.length
      }

      await tx`
        INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
        VALUES (${taskName}, ${scope}, ${toBlock.toString()}::bigint, NOW())
        ON CONFLICT (task, scope) DO UPDATE SET
          last_block = GREATEST(worker_cursors.last_block, EXCLUDED.last_block),
          last_run_at = NOW()
      `
    })
    cursor = toBlock + 1n
    iterations++
  }

  return { rpcCalls, rowsWritten }
}
