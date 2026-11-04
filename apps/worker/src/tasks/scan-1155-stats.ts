/**
 * Per-token ERC-1155 stats. drpc-only — no Alchemy NFT API.
 *
 * Strategy:
 *   - `total_supply`: read via `totalSupply(uint256)` eth_call on the
 *     contract. Mint protocol contracts implement it; Manifold Creator
 *     Cores typically do too. Contracts that don't implement it leave
 *     the column at 0.
 *   - `owner_count`: distinct holders with a positive balance in
 *     `token_1155_balances` (scan-1155-balances, #296), once that
 *     scanner's cursor for the contract has caught up to within
 *     CAUGHT_UP_BLOCKS of the safe head. Before that (backfill still
 *     running, or a contract outside the balance scanner's known-artist
 *     scope) it stays 0 and the UI renders "—", rather than showing a
 *     partial count. Supply and holder count stay separate numbers: one
 *     wallet can hold many editions.
 *
 * Scope: tokens in `artist_tokens` flagged ERC-1155 (platform='mint'
 * OR contract_identity.is_erc1155 OR manifold_contracts.is_erc1155).
 * Refreshed every 30 min so newly-minted editions reflect within the
 * cycle.
 */
import { sql } from "../db.ts"
import { client, safeHead } from "../rpc.ts"
import { getAddress, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"
import { TASK as BALANCES_TASK } from "./scan-1155-balances.ts"

// A balance cursor this close to the safe head counts as caught up
// (~1 day of blocks: a contract backed off for a few hours keeps its count).
const CAUGHT_UP_BLOCKS = 7_200n

const BATCH_SIZE = 50
const STALE_AFTER = "12 hours"

const totalSupplyAbi = [{
  type: "function" as const,
  name: "totalSupply",
  stateMutability: "view" as const,
  inputs: [{ name: "id", type: "uint256" as const }],
  outputs: [{ type: "uint256" as const }],
}] as const

type Candidate = { contract: string; tokenId: string }

export async function scan1155Stats(): Promise<TaskResult> {
  if (!sql) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const candidates = (await sql.unsafe(
    `WITH erc1155_tokens AS (
       SELECT lower(at.contract) AS contract, at.token_id
       FROM artist_tokens at
       LEFT JOIN contract_identity ci ON ci.address = lower(at.contract)
       LEFT JOIN manifold_contracts mc
         ON mc.artist = at.artist AND mc.contract = lower(at.contract)
       WHERE at.platform = 'mint'
          OR ci.is_erc1155 = true
          OR mc.is_erc1155 = true
     )
     SELECT e.contract, e.token_id AS "tokenId"
     FROM erc1155_tokens e
     LEFT JOIN token_1155_stats s
       ON s.contract = e.contract AND s.token_id = e.token_id
     WHERE s.contract IS NULL
        OR s.fetched_at < NOW() - INTERVAL '${STALE_AFTER}'
     LIMIT ${BATCH_SIZE}`,
  )) as Array<Candidate>

  if (candidates.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  // One multicall for all totalSupply(tokenId) reads.
  const calls = candidates.map((c) => ({
    address: getAddress(c.contract) as Address,
    abi: totalSupplyAbi,
    functionName: "totalSupply" as const,
    args: [BigInt(c.tokenId)] as const,
  }))
  const results = (await client.multicall({
    contracts: calls,
    allowFailure: true,
  })) as Array<{ status: "success"; result: unknown } | { status: "failure" }>
  let rpcCalls = Math.max(1, Math.ceil(calls.length / 250))

  // Safe head for the holder-count coverage check (cached; usually free).
  let headBlock: bigint | null = null
  try {
    const head = await safeHead.get()
    rpcCalls += head.rpcCalls
    headBlock = head.block
  } catch (err) {
    console.warn("[scan-1155-stats] safe head unavailable, holder counts left at 0:", err)
  }

  let rowsWritten = 0
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const r = results[i]
    // Prefer event-derived supply: Σ minted value from token_1155_mints,
    // which the mint-clone scanner records per mint event. The on-chain
    // totalSupply(id) reverts on Mint protocol contracts (no ERC1155Supply),
    // so the eth_call only serves as a fallback for contracts that do
    // implement it (e.g. Manifold ERC1155Supply) and whose mints we haven't
    // recorded in token_1155_mints.
    const mintedRow = (await sql`
      SELECT COALESCE(SUM(amount::numeric), 0)::text AS minted
      FROM token_1155_mints
      WHERE contract = ${c.contract} AND token_id = ${c.tokenId}
    `) as Array<{ minted: string }>
    const minted = BigInt(mintedRow[0]?.minted ?? "0")
    const ethCallSupply = r.status === "success" ? (r.result as bigint) : 0n
    const supply = minted > 0n ? minted : ethCallSupply
    const holderRow = (await sql`
      SELECT (SELECT count(*)::int FROM token_1155_balances
               WHERE contract = ${c.contract} AND token_id = ${c.tokenId}) AS holders,
             (SELECT last_block::text FROM worker_cursors
               WHERE task = ${BALANCES_TASK} AND scope = ${c.contract}) AS cursor
    `) as Array<{ holders: number; cursor: string | null }>
    const balanceCursor = holderRow[0]?.cursor == null ? null : BigInt(holderRow[0].cursor)
    const caughtUp = headBlock !== null && balanceCursor !== null &&
      balanceCursor >= headBlock - CAUGHT_UP_BLOCKS
    const ownerCount = caughtUp ? Number(holderRow[0]?.holders ?? 0) : 0
    await sql`
      INSERT INTO token_1155_stats
        (contract, token_id, total_supply, owner_count, fetched_at)
      VALUES (${c.contract}, ${c.tokenId}, ${supply.toString()}, ${ownerCount}, NOW())
      ON CONFLICT (contract, token_id) DO UPDATE SET
        total_supply = EXCLUDED.total_supply,
        owner_count = EXCLUDED.owner_count,
        fetched_at = NOW()
    `
    rowsWritten++
  }

  return { scopeCount: candidates.length, rpcCalls, rowsWritten }
}
