import "server-only"
import { unstable_cache } from "next/cache"
import { sql } from "./db"

/**
 * Resolve a representative thumbnail URL per declared catalog contract.
 *
 * For each contract address, pick the indexed token with the lowest
 * `token_id` that has a non-null `image_url` — visually stable across
 * page loads and biased toward "first piece in the collection" rather
 * than a randomly picked token. One Postgres roundtrip with a single
 * `DISTINCT ON` keyed by contract, so the cost is O(contracts) regardless
 * of how many tokens each contract has.
 *
 * Returns a plain object so the result can pass through Next.js
 * `unstable_cache` (Map is not JSON-serializable).
 */
const THUMB_TTL_S = 600

async function fetchContractThumbnails(
  contractsCsv: string,
): Promise<Record<string, string>> {
  if (!sql || contractsCsv.length === 0) return {}
  const lowered = contractsCsv.split(",").filter(Boolean)
  if (lowered.length === 0) return {}

  // numeric cast on token_id keeps the per-contract ordering correct
  // when ids are very large (uint256 max overflows bigint). DISTINCT ON
  // collapses to one row per contract.
  const rows = (await sql<
    Array<{ contract: string; image_url: string }>
  >`
    SELECT DISTINCT ON (contract) contract, image_url
    FROM token_metadata
    WHERE contract = ANY(${lowered})
      AND image_url IS NOT NULL
      AND image_url <> ''
    ORDER BY contract, token_id::numeric
  `) as Array<{ contract: string; image_url: string }>

  const out: Record<string, string> = {}
  for (const r of rows) out[r.contract] = r.image_url
  return out
}

const cachedFetch = unstable_cache(fetchContractThumbnails, ["catalog-thumbs-v1"], {
  revalidate: THUMB_TTL_S,
  tags: ["catalog"],
})

export async function getContractThumbnails(
  contracts: readonly string[],
): Promise<Record<string, string>> {
  const lowered = Array.from(
    new Set(contracts.map((c) => c.toLowerCase())),
  ).sort()
  // Pass a sorted-csv key so the cache hits across requests that ask
  // for the same set in any order.
  return cachedFetch(lowered.join(","))
}
