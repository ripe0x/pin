import "server-only"
import { sql } from "./db"

/**
 * Persistent token metadata index. See `db/migrations/015_token_metadata.sql`
 * for the schema rationale. Replaces the `pgCache("token-metadata:...", 1h)`
 * pattern: instead of expiring every hour, rows live forever once written.
 *
 * Read API:
 *   readTokenMetadata(contract, tokenId): returns the stored row, or null
 *   if never fetched. A row with all metadata fields null means "we tried,
 *   nothing useful was returned" — caller should treat as resolved-empty,
 *   NOT trigger a re-fetch.
 *
 * Write API:
 *   writeTokenMetadata(contract, tokenId, partial): upserts. Updates
 *   fetched_at to NOW() so the optional refresh sweep has a fresh anchor.
 *
 * When DATABASE_URL is unset, both functions no-op (read returns null,
 * write swallows). Caller falls through to live resolution. Same kill
 * switch behavior as `pgCache`.
 */

export type StoredTokenMetadata = {
  name: string | null
  description: string | null
  imageUrl: string | null
  rawUri: string | null
  fetchedAt: Date
}

export async function readTokenMetadata(
  contract: string,
  tokenId: string,
): Promise<StoredTokenMetadata | null> {
  if (!sql) return null
  try {
    const rows = await sql<
      Array<{
        name: string | null
        description: string | null
        image_url: string | null
        raw_uri: string | null
        fetched_at: Date
      }>
    >`
      SELECT name, description, image_url, raw_uri, fetched_at
      FROM token_metadata
      WHERE contract = ${contract.toLowerCase()} AND token_id = ${tokenId}
      LIMIT 1
    `
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      name: r.name,
      description: r.description,
      imageUrl: r.image_url,
      rawUri: r.raw_uri,
      fetchedAt: r.fetched_at,
    }
  } catch {
    return null
  }
}

export type WriteTokenMetadataInput = {
  name?: string | null
  description?: string | null
  imageUrl?: string | null
  rawUri?: string | null
}

export function writeTokenMetadata(
  contract: string,
  tokenId: string,
  input: WriteTokenMetadataInput,
): void {
  if (!sql) return
  // Fire-and-forget: an upstream fetch already cost the user the wait;
  // don't add Postgres write latency on top. If the write fails the next
  // read will simply re-resolve.
  void sql`
    INSERT INTO token_metadata (contract, token_id, name, description, image_url, raw_uri, fetched_at)
    VALUES (
      ${contract.toLowerCase()},
      ${tokenId},
      ${input.name ?? null},
      ${input.description ?? null},
      ${input.imageUrl ?? null},
      ${input.rawUri ?? null},
      NOW()
    )
    ON CONFLICT (contract, token_id) DO UPDATE
      SET name = EXCLUDED.name,
          description = EXCLUDED.description,
          image_url = EXCLUDED.image_url,
          raw_uri = EXCLUDED.raw_uri,
          fetched_at = EXCLUDED.fetched_at
  `.catch(() => {})
}
