/**
 * Per-artist Manifold scan. Manifold doesn't have a single discoverable
 * factory we can subscribe to (creator cores are hand-deployed), so this
 * stays a worker-only flow that uses Etherscan `txlist` + Alchemy
 * `getAssetTransfers`. Same pattern v1 had at
 * apps/web/src/lib/manifold-discovery.ts — ported here as the scanner.
 *
 * One artist's failure doesn't stop the others, but it isn't swallowed
 * either: every failed range (whose cursor was held, see scan-range.ts)
 * and every thrown per-artist error is returned in `errors`, which
 * records the iteration as failed in worker_iterations.
 */
import { sql } from "../db.ts"
import { scanManifoldArtistTokens } from "../scanners/manifold.ts"
import { describeScanError } from "../scan-range.ts"
import type { TaskResult } from "../scheduler.ts"

export async function scanManifold(): Promise<TaskResult> {
  const artists = (await sql`
    SELECT address FROM known_artists
  `) as Array<{ address: string }>

  let totalRpc = 0
  let totalRows = 0
  const errors: string[] = []

  for (const { address } of artists) {
    const r = await scanManifoldArtistTokens(address).catch((err) => {
      console.error(`[scan-manifold] ${address}:`, err)
      return { rpcCalls: 0, rowsWritten: 0, errors: [describeScanError(address, err)] }
    })
    totalRpc += r.rpcCalls
    totalRows += r.rowsWritten
    errors.push(...r.errors)
  }

  return { scopeCount: artists.length, rpcCalls: totalRpc, rowsWritten: totalRows, errors }
}
