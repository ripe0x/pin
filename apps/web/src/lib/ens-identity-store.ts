import "server-only"
import { sql } from "./db"

/**
 * Persistent ENS identity index. See `db/migrations/018_ens_identities.sql`
 * for the schema rationale. Replaces the `pgCache("efp-ens:..." / "ens:..." /
 * "ens-avatar:...", 24h)` pattern: rows live forever once written, with no
 * TTL re-resolution.
 *
 * Read API:
 *   readEnsIdentity(address): returns the stored row, or null if never
 *   fetched. A row with both fields null means "we tried, this address has
 *   no ENS record" — caller should treat as resolved-empty, NOT trigger a
 *   re-fetch.
 *
 * Write API:
 *   writeEnsIdentity(address, ensName, avatarUrl): upserts. Updates
 *   `resolved_at` to NOW() so any optional refresh sweep has a fresh anchor.
 *
 * When DATABASE_URL is unset, both functions no-op (read returns null,
 * write swallows). Caller falls through to live resolution. Same kill
 * switch behavior as `pgCache` and `token-metadata-store`.
 */

export type StoredEnsIdentity = {
  ensName: string | null
  avatarUrl: string | null
  resolvedAt: Date
}

export async function readEnsIdentity(
  address: string,
): Promise<StoredEnsIdentity | null> {
  if (!sql) return null
  try {
    const rows = await sql<
      Array<{
        ens_name: string | null
        avatar_url: string | null
        resolved_at: Date
      }>
    >`
      SELECT ens_name, avatar_url, resolved_at
      FROM ens_identities
      WHERE address = ${address.toLowerCase()}
      LIMIT 1
    `
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      ensName: r.ens_name,
      avatarUrl: r.avatar_url,
      resolvedAt: r.resolved_at,
    }
  } catch {
    return null
  }
}

export type WriteEnsIdentityInput = {
  ensName: string | null
  avatarUrl: string | null
}

export function writeEnsIdentity(
  address: string,
  input: WriteEnsIdentityInput,
): void {
  if (!sql) return
  // Fire-and-forget: an upstream resolve already cost the caller the wait;
  // don't add Postgres write latency on top. If the write fails the next
  // read will simply re-resolve.
  void sql`
    INSERT INTO ens_identities (address, ens_name, avatar_url, resolved_at)
    VALUES (
      ${address.toLowerCase()},
      ${input.ensName ?? null},
      ${input.avatarUrl ?? null},
      NOW()
    )
    ON CONFLICT (address) DO UPDATE
      SET ens_name = EXCLUDED.ens_name,
          avatar_url = EXCLUDED.avatar_url,
          resolved_at = EXCLUDED.resolved_at
  `.catch(() => {})
}
