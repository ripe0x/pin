import "server-only"
import { sql } from "./db"

const ADMIN_ADDRESSES = new Set(
  (process.env.NEXT_PUBLIC_GOD_MODE_ADDRESSES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^0x[0-9a-f]{40}$/.test(value)),
)

/** Authorize from indexed facts only, without adding a request-time RPC read. */
export async function canRefreshTokenMetadata(
  signer: string,
  contract: string,
  tokenId: string,
): Promise<boolean> {
  const actor = signer.toLowerCase()
  if (ADMIN_ADDRESSES.has(actor)) return true
  if (!sql) return false

  try {
    const rows = await sql<{ allowed: boolean }[]>`
      SELECT (
        EXISTS (
          SELECT 1 FROM token_owners
          WHERE contract = ${contract} AND token_id = ${tokenId}
            AND lower(owner) = ${actor}
        )
        OR EXISTS (
          SELECT 1 FROM work_attributions
          WHERE contract = ${contract} AND token_id = ${tokenId}
            AND lower(artist) = ${actor}
        )
        OR EXISTS (
          SELECT 1 FROM artist_tokens
          WHERE contract = ${contract} AND token_id = ${tokenId}
            AND lower(artist) = ${actor}
        )
      ) AS allowed
    `
    return rows[0]?.allowed === true
  } catch {
    // Fail closed during a migration or index outage. The background warmer
    // still repairs metadata without exposing a public worker queue.
    return false
  }
}
