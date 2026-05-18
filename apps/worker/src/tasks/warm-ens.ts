/**
 * Resolve ENS reverse + avatar for known artists + auction
 * counterparties that don't yet have an `ens_identities` row.
 *
 * Cheap per-address (one RPC call). Bounded by known_artists count +
 * winner/buyer counts (rough order: hundreds to low thousands of total
 * addresses ever).
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import type { TaskResult } from "../scheduler.ts"
import { getAddress, type Address } from "viem"
import { normalize } from "viem/ens"

const BATCH_SIZE = 20
const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export async function warmEns(): Promise<TaskResult> {
  const rows = (await sql.unsafe(
    `WITH all_addresses AS (
      SELECT lower(address) AS address FROM known_artists
      UNION SELECT lower(winner) FROM ${INDEXER_SCHEMA}.pnd_auctions WHERE winner IS NOT NULL
      UNION SELECT lower(buyer)  FROM ${INDEXER_SCHEMA}.fnd_sales   WHERE buyer  IS NOT NULL
    )
    SELECT a.address
    FROM all_addresses a
    LEFT JOIN ens_identities e ON e.address = a.address
    WHERE e.address IS NULL
    LIMIT ${BATCH_SIZE}`,
  )) as Array<{ address: string }>

  if (rows.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  let rpcCalls = 0
  let rowsWritten = 0

  for (const { address } of rows) {
    try {
      const addr = getAddress(address) as Address
      const name = await client.getEnsName({ address: addr }).catch(() => null)
      rpcCalls += 1

      let avatar: string | null = null
      if (name) {
        try {
          avatar = await client.getEnsAvatar({ name: normalize(name) })
          rpcCalls += 1
        } catch {
          avatar = null
        }
      }

      // Persist even when both null — that's the "we tried and they have
      // no record" sentinel so we don't re-query every cycle.
      await sql`
        INSERT INTO ens_identities (address, ens_name, avatar_url, resolved_at)
        VALUES (${address}, ${name}, ${avatar}, NOW())
        ON CONFLICT (address) DO UPDATE SET
          ens_name = EXCLUDED.ens_name,
          avatar_url = EXCLUDED.avatar_url,
          resolved_at = NOW()
      `
      rowsWritten += 1
    } catch (err) {
      console.error(`[warm-ens] ${address}:`, err)
    }
  }

  return { scopeCount: rows.length, rpcCalls, rowsWritten }
}
