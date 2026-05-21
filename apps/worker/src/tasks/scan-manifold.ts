/**
 * Per-artist Manifold scan. Manifold doesn't have a single discoverable
 * factory we can subscribe to (creator cores are hand-deployed), so this
 * stays a worker-only flow that uses Etherscan `txlist` + Alchemy
 * `getAssetTransfers`. Same pattern v1 had at
 * apps/web/src/lib/manifold-discovery.ts — ported here as the scanner.
 */
import { sql } from "../db.ts"
import { scanManifoldArtistTokens } from "../scanners/manifold.ts"
import type { TaskResult } from "../scheduler.ts"

export async function scanManifold(): Promise<TaskResult> {
  const artists = (await sql`
    SELECT address FROM known_artists
  `) as Array<{ address: string }>

  let totalRpc = 0
  let totalRows = 0

  for (const { address } of artists) {
    const r = await scanManifoldArtistTokens(address).catch((err) => {
      console.error(`[scan-manifold] ${address}:`, err)
      return { rpcCalls: 0, rowsWritten: 0 }
    })
    totalRpc += r.rpcCalls
    totalRows += r.rowsWritten
  }

  return { scopeCount: artists.length, rpcCalls: totalRpc, rowsWritten: totalRows }
}
