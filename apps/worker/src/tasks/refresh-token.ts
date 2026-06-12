/**
 * Force a single token's metadata re-fetch, on demand.
 *
 * Triggered by the per-token "Refresh metadata" button (web → worker via
 * `POST /jobs/refresh-token/:contract/:tokenId`). Unlike `warm-metadata`,
 * which only re-attempts all-NULL rows older than 7 days, this re-resolves
 * a specific token right now regardless of its current row state — the
 * recovery path for a token whose metadata was unavailable when first
 * warmed (and got a sentinel row) but is reachable now.
 *
 * Key difference from `warm-metadata.processOne`: on a failed/empty resolve
 * we do NOT overwrite existing content with a sentinel — we only bump
 * `fetched_at`. A manual refresh must never make a good row worse if the
 * upstream happens to be down at click time.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { resolveTokenMetadataWithState } from "@pin/token-metadata"

export async function refreshToken(
  contract: string,
  tokenId: string,
): Promise<"resolved" | "empty"> {
  const c = contract.toLowerCase()
  try {
    const { metadata: meta, exists } = await resolveTokenMetadataWithState(
      client,
      c,
      tokenId,
    )
    const hasContent =
      meta && (meta.name || meta.description || meta.image || meta.animation_url)

    if (hasContent) {
      await sql`
        INSERT INTO token_metadata
          (contract, token_id, name, description, image_url, animation_url, raw_uri, burned, fetched_at)
        VALUES
          (${c}, ${tokenId},
           ${meta.name ?? null}, ${meta.description ?? null},
           ${meta.image ?? null}, ${meta.animation_url ?? null},
           ${meta.uri ?? null}, FALSE, NOW())
        ON CONFLICT (contract, token_id) DO UPDATE SET
          name = EXCLUDED.name, description = EXCLUDED.description,
          image_url = EXCLUDED.image_url, animation_url = EXCLUDED.animation_url,
          raw_uri = EXCLUDED.raw_uri, burned = FALSE, fetched_at = NOW()
      `
      console.log(`[refresh-token] ${c}/${tokenId}: resolved`)
      return "resolved"
    }

    // Definitive burn (tokenURI reverted nonexistent) — flag it so the token
    // page 404s and it drops out of artist grids. Leave content columns
    // untouched (a refresh must never make a good row worse); the flag alone
    // is what the readers gate on.
    if (exists === false) {
      await sql`
        INSERT INTO token_metadata
          (contract, token_id, name, description, image_url, animation_url, raw_uri, burned, fetched_at)
        VALUES (${c}, ${tokenId}, NULL, NULL, NULL, NULL, NULL, TRUE, NOW())
        ON CONFLICT (contract, token_id) DO UPDATE SET
          burned = TRUE, fetched_at = NOW()
      `
      console.log(`[refresh-token] ${c}/${tokenId}: burned`)
      return "empty"
    }

    // Resolved nothing, existence indeterminate (transient upstream) — bump
    // fetched_at only, preserving any existing content (don't clobber a
    // previously-good row with a sentinel).
    await bumpFetchedAt(c, tokenId)
    console.log(`[refresh-token] ${c}/${tokenId}: empty (content preserved)`)
    return "empty"
  } catch (err) {
    console.error(`[refresh-token] ${c}/${tokenId}:`, err)
    await bumpFetchedAt(c, tokenId)
    return "empty"
  }
}

/**
 * Insert a sentinel row if none exists, otherwise just advance `fetched_at`
 * without touching the payload columns. Drives the per-token rate limit
 * (web reads `fetched_at`) without destroying good content on a failed
 * refresh.
 */
async function bumpFetchedAt(contract: string, tokenId: string): Promise<void> {
  await sql`
    INSERT INTO token_metadata
      (contract, token_id, name, description, image_url, animation_url, raw_uri, fetched_at)
    VALUES (${contract}, ${tokenId}, NULL, NULL, NULL, NULL, NULL, NOW())
    ON CONFLICT (contract, token_id) DO UPDATE SET fetched_at = NOW()
  `.catch(() => {})
}
