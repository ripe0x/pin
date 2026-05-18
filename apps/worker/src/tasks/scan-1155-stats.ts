/**
 * Per-token ERC-1155 stats. drpc-only — no Alchemy NFT API.
 *
 * Strategy:
 *   - `total_supply`: read via `totalSupply(uint256)` eth_call on the
 *     contract. Mint protocol contracts implement it; Manifold Creator
 *     Cores typically do too. Contracts that don't implement it leave
 *     the column at 0.
 *   - `owner_count`: not surfaced. Computing it without an off-chain
 *     index requires either (a) Alchemy's getOwnersForNFT (out of
 *     scope on drpc-free) or (b) maintaining a per-(token, holder)
 *     balance ledger from all TransferSingle/Batch events (too
 *     expensive). UI renders "—" when owner_count is 0.
 *
 * Scope: tokens in `artist_tokens` flagged ERC-1155 (platform='mint'
 * OR contract_identity.is_erc1155 OR manifold_contracts.is_erc1155).
 * Refreshed every 30 min so newly-minted editions reflect within the
 * cycle.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { getAddress, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"

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
  const rpcCalls = Math.max(1, Math.ceil(calls.length / 250))

  let rowsWritten = 0
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const r = results[i]
    const supply = r.status === "success" ? (r.result as bigint) : 0n
    await sql`
      INSERT INTO token_1155_stats
        (contract, token_id, total_supply, owner_count, fetched_at)
      VALUES (${c.contract}, ${c.tokenId}, ${supply.toString()}, 0, NOW())
      ON CONFLICT (contract, token_id) DO UPDATE SET
        total_supply = EXCLUDED.total_supply,
        owner_count = EXCLUDED.owner_count,
        fetched_at = NOW()
    `
    rowsWritten++
  }

  return { scopeCount: candidates.length, rpcCalls, rowsWritten }
}
