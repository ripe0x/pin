/**
 * Finalized ERC-721 ownership scanner. Historical contracts catch up in
 * bounded individual lanes; caught-up contracts share multi-address log
 * requests. A complete range and every affected cursor commit together.
 */
import { getAddress, parseAbiItem, type Address } from "viem"
import { sql } from "../db.ts"
import { getFinalizedBoundary } from "../finality.ts"
import { recordErc721Ownership, ZERO_ADDRESS } from "../ownership-store.ts"
import { client } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import type { TaskResult } from "../scheduler.ts"

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
const TASK = "scan-token-transfers"
const MAX_BLOCKS_PER_SCAN = 9_500n
const MAX_HISTORICAL_CHUNKS_PER_TICK = 20
const ADDRESS_BATCH_SIZE = 75

type ContractState = {
  contract: string
  earliestMintBlock: bigint
  lastBlock: bigint | null
}

async function getContractStates(): Promise<ContractState[]> {
  const rows = (await sql`
    SELECT lower(t.contract) AS contract,
           MIN(t.mint_block)::text AS earliest_mint_block,
           c.last_block::text AS last_block
    FROM artist_tokens t
    LEFT JOIN worker_cursors c
      ON c.task = ${TASK} AND c.scope = lower(t.contract)
    WHERE t.platform NOT IN ('fnd-shared', 'srv2-shared')
    GROUP BY lower(t.contract), c.last_block
    ORDER BY COALESCE(c.last_block, MIN(t.mint_block)) ASC, lower(t.contract)
  `) as Array<{ contract: string; earliest_mint_block: string; last_block: string | null }>
  return rows.map((row) => ({
    contract: row.contract,
    earliestMintBlock: BigInt(row.earliest_mint_block),
    lastBlock: row.last_block === null ? null : BigInt(row.last_block),
  }))
}

async function getKnownTokens(states: ContractState[]): Promise<Map<string, Set<string>>> {
  const contracts = states.map(({ contract }) => contract)
  if (contracts.length === 0) return new Map()
  const rows = (await sql`
    SELECT lower(contract) AS contract, token_id
    FROM artist_tokens
    WHERE lower(contract) = ANY(${contracts}::text[])
  `) as Array<{ contract: string; token_id: string }>
  const known = new Map<string, Set<string>>()
  for (const row of rows) {
    const tokens = known.get(row.contract) ?? new Set<string>()
    tokens.add(row.token_id)
    known.set(row.contract, tokens)
  }
  return known
}

export async function scanTokenTransfers(): Promise<TaskResult> {
  const states = await getContractStates()
  if (states.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  const knownTokens = await getKnownTokens(states)
  const boundary = await getFinalizedBoundary(client)
  const head = boundary.blockNumber
  let rpcCalls = boundary.rpcCalls
  let rowsWritten = 0

  const blockTimes = new Map<bigint, bigint>()
  const blockTimeFor = async (blockNumber: bigint): Promise<bigint> => {
    const cached = blockTimes.get(blockNumber)
    if (cached !== undefined) return cached
    await throttleRpc()
    const block = await client.getBlock({ blockNumber })
    rpcCalls += 1
    blockTimes.set(blockNumber, block.timestamp)
    return block.timestamp
  }

  const nextBlock = (state: ContractState) =>
    state.lastBlock === null ? state.earliestMintBlock : state.lastBlock + 1n
  const historical = states.filter((state) => head - nextBlock(state) >= MAX_BLOCKS_PER_SCAN)
  const caughtUp = states.filter((state) => head - nextBlock(state) < MAX_BLOCKS_PER_SCAN)

  for (const state of historical.slice(0, MAX_HISTORICAL_CHUNKS_PER_TICK)) {
    const fromBlock = nextBlock(state)
    if (fromBlock > head) continue
    const toBlock = fromBlock + MAX_BLOCKS_PER_SCAN - 1n > head
      ? head
      : fromBlock + MAX_BLOCKS_PER_SCAN - 1n
    const result = await scanRange(
      [state],
      fromBlock,
      toBlock,
      knownTokens,
      blockTimeFor,
    )
    rpcCalls += result.rpcCalls
    rowsWritten += result.rowsWritten
  }

  for (let offset = 0; offset < caughtUp.length; offset += ADDRESS_BATCH_SIZE) {
    const batch = caughtUp.slice(offset, offset + ADDRESS_BATCH_SIZE)
    const active = batch.filter((state) => nextBlock(state) <= head)
    if (active.length === 0) continue
    const fromBlock = active.reduce(
      (minimum, state) => nextBlock(state) < minimum ? nextBlock(state) : minimum,
      nextBlock(active[0]),
    )
    const result = await scanRange(
      active,
      fromBlock,
      head,
      knownTokens,
      blockTimeFor,
    )
    rpcCalls += result.rpcCalls
    rowsWritten += result.rowsWritten
  }

  return { scopeCount: states.length, rpcCalls, rowsWritten }
}

async function scanRange(
  states: ContractState[],
  fromBlock: bigint,
  toBlock: bigint,
  knownTokens: Map<string, Set<string>>,
  blockTimeFor: (blockNumber: bigint) => Promise<bigint>,
): Promise<{ rpcCalls: number; rowsWritten: number }> {
  await throttleRpc()
  const logs = await client.getLogs({
    address: states.map(({ contract }) => getAddress(contract) as Address),
    event: TRANSFER_EVENT,
    fromBlock,
    toBlock,
  })

  const relevant = logs.filter((log) => {
    if (log.args.tokenId === undefined) return false
    return knownTokens.get(log.address.toLowerCase())?.has(log.args.tokenId.toString()) ?? false
  })
  const times = new Map<bigint, bigint>()
  for (const log of relevant) {
    if (log.blockNumber === null) throw new Error("transfer log missing block number")
    if (!times.has(log.blockNumber)) {
      times.set(log.blockNumber, await blockTimeFor(log.blockNumber))
    }
  }

  let rowsWritten = 0
  await sql.begin(async (tx) => {
    for (const log of relevant) {
      if (
        log.args.tokenId === undefined || log.blockNumber === null ||
        log.logIndex === null || !log.transactionHash
      ) {
        throw new Error("transfer log missing durable identity")
      }
      const contract = log.address.toLowerCase()
      const tokenId = log.args.tokenId.toString()
      const owner = (log.args.to ?? ZERO_ADDRESS).toLowerCase()
      const blockTime = times.get(log.blockNumber)!
      const inserted = await tx`
        INSERT INTO token_transfers
          (contract, token_id, from_addr, to_addr, block_number, log_index,
           tx_hash, block_hash, block_time)
        VALUES
          (${contract}, ${tokenId}, ${(log.args.from ?? ZERO_ADDRESS).toLowerCase()},
           ${owner}, ${log.blockNumber.toString()}::bigint, ${log.logIndex},
           ${log.transactionHash}, ${log.blockHash ?? null},
           ${blockTime.toString()}::bigint)
        ON CONFLICT (contract, token_id, tx_hash, log_index) DO NOTHING
        RETURNING 1
      `
      rowsWritten += inserted.count
      await recordErc721Ownership(tx, {
        contract,
        tokenId,
        owner,
        source: "worker-transfer",
        blockNumber: log.blockNumber,
        logIndex: BigInt(log.logIndex),
        txHash: log.transactionHash,
        blockTime,
        finalized: true,
        coverageStatus: "complete",
      })
    }

    for (const state of states) {
      await tx`
        INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
        VALUES (${TASK}, ${state.contract}, ${toBlock.toString()}::bigint, NOW())
        ON CONFLICT (task, scope) DO UPDATE SET
          last_block = GREATEST(worker_cursors.last_block, EXCLUDED.last_block),
          last_run_at = NOW()
      `
    }
  })
  return { rpcCalls: 1, rowsWritten }
}
