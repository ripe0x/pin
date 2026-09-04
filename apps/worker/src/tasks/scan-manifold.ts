/**
 * Per-artist Manifold scan. Manifold doesn't have a single discoverable
 * factory we can subscribe to (creator cores are hand-deployed), so this
 * stays a worker-only flow that uses Etherscan `txlist` + Alchemy
 * `getAssetTransfers`. Same pattern v1 had at
 * apps/web/src/lib/manifold-discovery.ts — ported here as the scanner.
 */
import { sql } from "../db.ts"
import { getFinalizedBoundary } from "../finality.ts"
import { client } from "../rpc.ts"
import { scanManifoldArtistTokens } from "../scanners/manifold.ts"
import type { TaskResult } from "../scheduler.ts"

export async function scanManifold(): Promise<TaskResult> {
  const artists = (await sql`
    SELECT address FROM known_artists
  `) as Array<{ address: string }>

  const boundary = await getFinalizedBoundary(client)
  let totalRpc = boundary.rpcCalls
  let totalRows = 0

  for (const { address } of artists) {
    const r = await scanManifoldArtistTokens(address, boundary.blockNumber)
    totalRpc += r.rpcCalls
    totalRows += r.rowsWritten
  }

  return { scopeCount: artists.length, rpcCalls: totalRpc, rowsWritten: totalRows }
}
