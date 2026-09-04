/**
 * Generic incremental ERC-1155 scanner. Watches TransferSingle and
 * TransferBatch once, deriving mint discovery and current holder balances
 * from the same log responses.
 *
 * Used by Mint protocol clones. Each clone's tokens go into
 * `artist_tokens` with platform='mint'.
 *
 * Edition handling: ERC-1155 editions share a tokenId on the same
 * contract. We collapse via `ON CONFLICT (contract, token_id) DO
 * NOTHING` — the first mint wins, subsequent edition mints are silently
 * deduped.
 */
import type { Sql } from "postgres"
import {
  parseAbiItem, getAddress, type Address, type PublicClient,
} from "viem"
import { throttleRpc } from "../throttle.ts"
import { recordErc1155Transfer, ZERO_ADDRESS } from "../ownership-store.ts"
import { getFinalizedBoundary } from "../finality.ts"

const TRANSFER_SINGLE = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
)
const TRANSFER_BATCH = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
)
const ZERO = ZERO_ADDRESS
// drpc free tier caps eth_getLogs at 10,000 blocks per call. Stay under
// with margin. Per-tick iteration count kept low so each cycle leaves
// budget for other tasks; backfill spread across many cycles is fine.
const MAX_BLOCKS_PER_SCAN = 9_500n
const MAX_ITERATIONS_PER_CALL = 15

export type Erc1155ScanArgs = {
  sql: Sql
  client: PublicClient
  taskName: string
  platform: string
  artist: string
  contract: string
  contractDeployBlock: bigint
  finalizedBlock?: bigint
}

export type Erc1155ScanResult = {
  rpcCalls: number
  rowsWritten: number
}

export type Erc1155ScanTarget = {
  artist: string
  contract: string
  contractDeployBlock: bigint
}

const ADDRESS_BATCH_SIZE = 75
const MAX_HISTORICAL_CONTRACTS_PER_TICK = 20

/** Batch caught-up ERC-1155 clones while preserving bounded backfill lanes. */
export async function scanErc1155TargetsFromZero(args: {
  sql: Sql
  client: PublicClient
  taskName: string
  platform: string
  targets: Erc1155ScanTarget[]
  finalizedBlock: bigint
}): Promise<Erc1155ScanResult> {
  const cursorTask = `${args.taskName}-ownership-v1`
  const targets = [...new Map(args.targets.map((target) => [
    `${target.artist.toLowerCase()}:${target.contract.toLowerCase()}`,
    {
      ...target,
      artist: target.artist.toLowerCase(),
      contract: target.contract.toLowerCase(),
    },
  ])).values()]
  if (targets.length === 0) return { rpcCalls: 0, rowsWritten: 0 }
  const scopes = targets.map((target) => `${target.artist}:${target.contract}`)
  const rows = (await args.sql`
    SELECT scope, last_block::text AS last_block
    FROM worker_cursors
    WHERE task = ${cursorTask} AND scope = ANY(${scopes}::text[])
  `) as Array<{ scope: string; last_block: string }>
  const cursors = new Map(rows.map((row) => [row.scope, BigInt(row.last_block)]))
  const states = targets.map((target) => {
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
    const result = await scanErc1155MintsFromZero({
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
    const addresses = batch.map((state) => getAddress(state.contract) as Address)
    await throttleRpc()
    const singles = await args.client.getLogs({
      address: addresses,
      event: TRANSFER_SINGLE,
      fromBlock,
      toBlock: args.finalizedBlock,
    })
    await throttleRpc()
    const batches = await args.client.getLogs({
      address: addresses,
      event: TRANSFER_BATCH,
      fromBlock,
      toBlock: args.finalizedBlock,
    })
    rpcCalls += 2

    const events = [
      ...singles.map((log) => ({ kind: "single" as const, log })),
      ...batches.map((log) => ({ kind: "batch" as const, log })),
    ].sort((a, b) => {
      const aBlock = a.log.blockNumber!
      const bBlock = b.log.blockNumber!
      if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1
      return Number(a.log.logIndex!) - Number(b.log.logIndex!)
    })
    const targetByContract = new Map(batch.map((state) => [state.contract, state]))
    const blockTimes = new Map<bigint, bigint>()
    const blockTimeFor = async (blockNumber: bigint): Promise<bigint> => {
      const cached = blockTimes.get(blockNumber)
      if (cached !== undefined) return cached
      await throttleRpc()
      const block = await args.client.getBlock({ blockNumber })
      rpcCalls += 1
      blockTimes.set(blockNumber, block.timestamp)
      return block.timestamp
    }

    for (const event of events) {
      if (
        event.log.blockNumber === null || event.log.logIndex === null ||
        !event.log.transactionHash
      ) {
        throw new Error("ERC-1155 log missing durable identity")
      }
      const target = targetByContract.get(event.log.address.toLowerCase())
      if (!target) throw new Error(`unexpected ERC-1155 contract ${event.log.address}`)
      const from = (event.log.args.from ?? ZERO).toLowerCase()
      const to = (event.log.args.to ?? ZERO).toLowerCase()
      const entries = event.kind === "single"
        ? event.log.args.id === undefined
          ? []
          : [{ tokenId: event.log.args.id, amount: event.log.args.value ?? 0n }]
        : (() => {
            const ids = (event.log.args.ids ?? []) as readonly bigint[]
            const values = (event.log.args.values ?? []) as readonly bigint[]
            if (ids.length !== values.length) {
              throw new Error(`Malformed ERC-1155 batch at ${event.log.transactionHash}`)
            }
            return ids.map((tokenId, index) => ({
              tokenId,
              amount: values[index],
            }))
          })()
      const ownership = await recordErc1155Transfer(args.sql, {
        contract: target.contract,
        from,
        to,
        entries,
        source: `worker-${args.platform}`,
        blockNumber: event.log.blockNumber,
        logIndex: BigInt(event.log.logIndex),
        txHash: event.log.transactionHash,
        finalized: true,
        coverageStatus: "complete",
      })
      rowsWritten += ownership.eventsApplied + ownership.balanceRowsChanged
      if (from !== ZERO || entries.length === 0) continue
      const timestamp = await blockTimeFor(event.log.blockNumber)
      for (const entry of entries) {
        const tokenId = BigInt(entry.tokenId).toString()
        const insertedToken = await args.sql`
          INSERT INTO artist_tokens
            (artist, contract, token_id, platform, mint_block, mint_log_index,
             mint_time, first_seen_at)
          VALUES
            (${target.artist}, ${target.contract}, ${tokenId}, ${args.platform},
             ${event.log.blockNumber.toString()}::bigint, ${event.log.logIndex},
             ${timestamp.toString()}::bigint, NOW())
          ON CONFLICT (contract, token_id) DO NOTHING
          RETURNING 1
        `
        const insertedMint = await args.sql`
          INSERT INTO token_1155_mints
            (contract, token_id, to_addr, amount, block_number, block_time,
             tx_hash, log_index)
          VALUES
            (${target.contract}, ${tokenId}, ${to}, ${BigInt(entry.amount).toString()},
             ${event.log.blockNumber.toString()}::bigint,
             ${timestamp.toString()}::bigint, ${event.log.transactionHash},
             ${event.log.logIndex})
          ON CONFLICT (tx_hash, log_index, token_id) DO NOTHING
          RETURNING 1
        `
        rowsWritten += insertedToken.length + insertedMint.length
      }
    }

    await args.sql.begin(async (tx) => {
      for (const state of batch) {
        await tx`
          INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
          VALUES
            (${cursorTask}, ${state.scope},
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

export async function scanErc1155MintsFromZero(
  args: Erc1155ScanArgs,
): Promise<Erc1155ScanResult> {
  const {
    sql, client, taskName, platform, artist, contract, contractDeployBlock,
    finalizedBlock,
  } = args
  const scope = `${artist}:${contract}`
  // The old cursor only proved mint-only logs had been scanned. Ownership v1
  // intentionally starts once from the clone deploy block so pre-existing
  // transfers and burns populate balances; subsequent runs are incremental.
  const cursorTask = `${taskName}-ownership-v1`

  const boundary = finalizedBlock === undefined
    ? await getFinalizedBoundary(client)
    : { blockNumber: finalizedBlock, rpcCalls: 0 }
  const head = boundary.blockNumber
  let rpcCalls = boundary.rpcCalls
  let rowsWritten = 0

  const cursorRow = (await sql`
    SELECT last_block::text AS last_block
    FROM worker_cursors WHERE task = ${cursorTask} AND scope = ${scope}
    LIMIT 1
  `) as Array<{ last_block: string }>
  let cursor = cursorRow[0] ? BigInt(cursorRow[0].last_block) + 1n : contractDeployBlock

  let iterations = 0
  while (cursor <= head && iterations < MAX_ITERATIONS_PER_CALL) {
    const toBlock = cursor + MAX_BLOCKS_PER_SCAN > head
      ? head
      : cursor + MAX_BLOCKS_PER_SCAN

    // Resolve block timestamps once per distinct block, so mint-history rows
    // carry real dates. Deduped + throttled; bounded by the number of distinct
    // mint blocks in the window (small — editions mint rarely).
    const blockTime = new Map<bigint, bigint>()
    const blockTimeFor = async (bn: bigint): Promise<bigint> => {
      const cached = blockTime.get(bn)
      if (cached !== undefined) return cached
      await throttleRpc()
      const blk = await client.getBlock({ blockNumber: bn })
      rpcCalls += 1
      blockTime.set(bn, blk.timestamp)
      return blk.timestamp
    }

    // Fetch both event signatures for the same range, then merge by chain
    // position. Processing all singles before all batches can debit before an
    // earlier batch mint in the same window and manufacture an underflow.
    await throttleRpc()
    const singles = await client.getLogs({
      address: getAddress(contract) as Address,
      event: TRANSFER_SINGLE,
      fromBlock: cursor,
      toBlock,
    })
    rpcCalls += 1

    await throttleRpc()
    const batches = await client.getLogs({
      address: getAddress(contract) as Address,
      event: TRANSFER_BATCH,
      fromBlock: cursor,
      toBlock,
    })
    rpcCalls += 1

    const events = [
      ...singles.map((log) => ({ kind: "single" as const, log })),
      ...batches.map((log) => ({ kind: "batch" as const, log })),
    ].sort((a, b) => {
      const aBlock = a.log.blockNumber!
      const bBlock = b.log.blockNumber!
      if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1
      return Number(a.log.logIndex!) - Number(b.log.logIndex!)
    })

    for (const event of events) {
      if (event.kind === "single") {
        const { log } = event
        if (log.args.id === undefined) continue
        const tokenId = log.args.id.toString()
        const from = (log.args.from ?? ZERO).toLowerCase()
        const to = (log.args.to ?? ZERO).toLowerCase()
        const ownership = await recordErc1155Transfer(sql, {
          contract,
          from,
          to,
          entries: [{ tokenId, amount: log.args.value ?? 0n }],
          source: `worker-${platform}`,
          blockNumber: log.blockNumber!,
          logIndex: BigInt(log.logIndex!),
          txHash: log.transactionHash!,
          finalized: true,
          coverageStatus: "complete",
        })
        rowsWritten += ownership.eventsApplied + ownership.balanceRowsChanged
        if (from !== ZERO) continue
        const ts = await blockTimeFor(log.blockNumber!)
        await sql`
          INSERT INTO artist_tokens
            (artist, contract, token_id, platform, mint_block, mint_log_index, mint_time, first_seen_at)
          VALUES
            (${artist}, ${contract}, ${tokenId}, ${platform},
             ${log.blockNumber!.toString()}::bigint, ${log.logIndex!}, ${ts.toString()}::bigint, NOW())
          ON CONFLICT (contract, token_id) DO NOTHING
        `
        rowsWritten += 1
        await sql`
          INSERT INTO token_1155_mints
            (contract, token_id, to_addr, amount, block_number, block_time, tx_hash, log_index)
          VALUES
            (${contract}, ${tokenId}, ${to},
             ${(log.args.value ?? 0n).toString()}, ${log.blockNumber!.toString()}::bigint,
             ${ts.toString()}::bigint, ${log.transactionHash!}, ${log.logIndex!})
          ON CONFLICT (tx_hash, log_index, token_id) DO NOTHING
        `
        continue
      }

      const { log } = event
      const ids = (log.args.ids ?? []) as readonly bigint[]
      const values = (log.args.values ?? []) as readonly bigint[]
      if (ids.length !== values.length) {
        throw new Error(
          `Malformed ERC-1155 TransferBatch at ${log.transactionHash}: ids/values length mismatch`,
        )
      }
      const from = (log.args.from ?? ZERO).toLowerCase()
      const to = (log.args.to ?? ZERO).toLowerCase()
      const ownership = await recordErc1155Transfer(sql, {
        contract,
        from,
        to,
        entries: ids.map((id, i) => ({ tokenId: id, amount: values[i] })),
        source: `worker-${platform}`,
        blockNumber: log.blockNumber!,
        logIndex: BigInt(log.logIndex!),
        txHash: log.transactionHash!,
        finalized: true,
        coverageStatus: "complete",
      })
      rowsWritten += ownership.eventsApplied + ownership.balanceRowsChanged
      if (from !== ZERO) continue
      const ts = ids.length > 0 ? await blockTimeFor(log.blockNumber!) : 0n
      for (let i = 0; i < ids.length; i++) {
        const tokenId = ids[i].toString()
        await sql`
          INSERT INTO artist_tokens
            (artist, contract, token_id, platform, mint_block, mint_log_index, mint_time, first_seen_at)
          VALUES
            (${artist}, ${contract}, ${tokenId}, ${platform},
             ${log.blockNumber!.toString()}::bigint, ${log.logIndex!}, ${ts.toString()}::bigint, NOW())
          ON CONFLICT (contract, token_id) DO NOTHING
        `
        rowsWritten += 1
        await sql`
          INSERT INTO token_1155_mints
            (contract, token_id, to_addr, amount, block_number, block_time, tx_hash, log_index)
          VALUES
            (${contract}, ${tokenId}, ${to}, ${(values[i] ?? 0n).toString()},
             ${log.blockNumber!.toString()}::bigint, ${ts.toString()}::bigint,
             ${log.transactionHash!}, ${log.logIndex!})
          ON CONFLICT (tx_hash, log_index, token_id) DO NOTHING
        `
      }
    }

    cursor = toBlock + 1n
    await sql`
      INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
      VALUES (${cursorTask}, ${scope}, ${toBlock.toString()}::bigint, NOW())
      ON CONFLICT (task, scope) DO UPDATE SET
        last_block = EXCLUDED.last_block, last_run_at = NOW()
    `
    iterations++
  }

  return { rpcCalls, rowsWritten }
}
