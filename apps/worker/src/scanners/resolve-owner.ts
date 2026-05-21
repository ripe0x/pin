/**
 * Event-triggered single-token owner resolution. Called by the
 * Transfer-from-zero and ERC-1155 scanners immediately after inserting
 * a new `artist_tokens` row.
 *
 * Why event-triggered: prevents the "token visible but owner null"
 * window that would otherwise exist between mint discovery (10 min
 * cadence) and the next `scan-token-transfers` pass (5 min cadence).
 *
 * Cost: one `ownerOf` per new mint. Bounded by mint rate, not by
 * visit rate.
 */
import type { Sql } from "postgres"
import { getAddress, type Address, type PublicClient, erc721Abi } from "viem"

export type ResolveOwnerArgs = {
  sql: Sql
  client: PublicClient
  contract: string
  tokenId: string
}

export async function resolveNewTokenOwner(args: ResolveOwnerArgs): Promise<void> {
  const { sql, client, contract, tokenId } = args

  // Skip if a more-recent transfer already set the owner.
  const existing = (await sql`
    SELECT 1 FROM token_owners
    WHERE lower(contract) = ${contract} AND token_id = ${tokenId}
    LIMIT 1
  `) as Array<{ "?column?": number }>
  if (existing.length > 0) return

  try {
    const owner = await client.readContract({
      address: getAddress(contract) as Address,
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    }) as string

    await sql`
      INSERT INTO token_owners
        (contract, token_id, owner, transferred_at_block, transferred_at_time, tx_hash)
      VALUES
        (${contract}, ${tokenId}, ${owner.toLowerCase()}, 0::bigint, 0::bigint, NULL)
      ON CONFLICT (contract, token_id) DO NOTHING
    `
  } catch {
    // ERC-1155 (no ownerOf) — that's fine; scan-token-transfers will
    // resolve ownership via the next Transfer event.
  }
}
