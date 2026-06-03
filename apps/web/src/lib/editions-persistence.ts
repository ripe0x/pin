import "server-only"
import { sql } from "./db"
import {
  classifyArtworkKey,
  resolveArtworkStatus,
  type ArtworkPersistenceKind,
  type ArtworkPersistenceStatus,
} from "./editions-persistence-status"

export type { ArtworkPersistenceKind, ArtworkPersistenceStatus }

/**
 * Honest persistence status for an edition's artwork, the Phase 4 "honest
 * mirror". Read ONLY from cached Postgres state, the worker's `cid_availability`
 * gateway probe (migration 018) overlaid with the artist's signed `token_pins`
 * attestation (migration 019). Never a live chain read and never a per-render
 * gateway fetch, per the minimize-RPC rule.
 *
 * There is deliberately no "backed up by PND" state: PND does not pin or host
 * editions media (see docs/pnd-editions-media-pinning.md). The signals are the
 * artist's own pin and independent gateway retrievability, nothing else.
 *
 * Note: a fresh edition's CID is "unprobed" until the worker reaches it. Edition
 * `artworkURI` CIDs enter the probe candidate set via the artist's pin
 * attestation (token_pins, now unioned into the probe) or editions discovery
 * indexing once that lands (deploy-gated). A CID already referenced elsewhere is
 * already probed (the cache is global + content-addressed).
 */
export type ArtworkPersistence = {
  kind: ArtworkPersistenceKind
  status: ArtworkPersistenceStatus
  /** The CID / Arweave tx id used as the cache key, if content-addressed. */
  key: string | null
}

export async function getArtworkPersistence(
  artworkURI: string,
  artist?: string,
): Promise<ArtworkPersistence> {
  const { kind, key } = classifyArtworkKey(artworkURI)
  if (kind === "none") return { kind, status: "none", key }
  if (kind === "external" || !key) return { kind: "external", status: "external", key: null }

  if (!sql) return { kind, status: "unprobed", key }

  const artistFilter = artist ? sql`AND tp.artist = ${artist.toLowerCase()}` : sql``

  const rows = (await sql<Array<{ retrievable: boolean | null; pinned: boolean }>>`
    SELECT
      (SELECT retrievable FROM cid_availability WHERE cid = ${key}) AS retrievable,
      EXISTS (
        SELECT 1 FROM token_pins tp
         WHERE tp.cid = ${key}
           AND tp.status IN ('pinned', 'queued')
           ${artistFilter}
      ) AS pinned
  `) as Array<{ retrievable: boolean | null; pinned: boolean }>

  const retrievable = rows[0]?.retrievable ?? null
  const pinned = rows[0]?.pinned ?? false

  return { kind, status: resolveArtworkStatus(retrievable, pinned), key }
}
