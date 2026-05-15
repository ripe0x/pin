import "server-only"
import { sql } from "./db"

/**
 * Gate helper for external-platform indexing. True iff the address is in
 * the `known_artists` Postgres view (Sovereign house deployer, FND
 * collection creator, FND minter, or Catalog declarant — see
 * db/migrations/022_known_artists_view.sql).
 *
 * This is the single gate that bounds Alchemy / Etherscan spend on the
 * Manifold / SuperRare V2 / Transient Labs platform adapters. The
 * adapters call this on cache miss; if false, they short-circuit
 * without touching external APIs.
 *
 * Lives in its own module to avoid a circular import — both the
 * adapters and `lib/external-indexer.ts` need it, but
 * `external-indexer.ts` also imports the adapters.
 *
 * Fails closed: returns `false` on DB error rather than `true`. A
 * degraded DB never expands the spend surface.
 */
export async function isKnownArtist(address: string): Promise<boolean> {
  if (!sql) return false
  try {
    const lower = address.toLowerCase()
    const rows = (await sql`
      SELECT EXISTS (
        SELECT 1 FROM known_artists WHERE address = ${lower}
      ) AS "exists"
    `) as Array<{ exists: boolean }>
    return rows[0]?.exists === true
  } catch {
    return false
  }
}
