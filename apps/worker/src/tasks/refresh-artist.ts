/**
 * On-demand single-artist refresh. Triggered by web's "Refresh my work"
 * button via POST /jobs/refresh-artist/:address.
 *
 * Runs the per-artist work that would otherwise wait for the next
 * scheduled scan tick. The scheduler's HTTP surface dedups concurrent
 * triggers per address.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { scanArtistTokensViaTransferFromZero } from "../scanners/transfer-from-zero.ts"
import { scanErc1155MintsFromZero } from "../scanners/erc1155-mints.ts"
import { scanManifoldArtistTokens, discoverMintsToArtist } from "../scanners/manifold.ts"
import type { Address } from "viem"

export async function refreshArtist(address: string): Promise<void> {
  const lower = address.toLowerCase()

  // Gate on known_artists; nothing scans for an unknown address.
  const known = (await sql`
    SELECT 1 FROM known_artists WHERE address = ${lower} LIMIT 1
  `) as Array<{ "?column?": number }>
  if (known.length === 0) {
    console.log(`[refresh-artist] ${lower} not in known_artists; skipping`)
    return
  }

  const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
    /[^a-zA-Z0-9_]/g, "",
  )

  // Each platform in parallel, isolated failure.
  await Promise.allSettled([
    // FND shared 1/1s: copy this artist's historical mints from the
    // frozen seed (migration 023). Pure SQL, zero RPC — the scheduled
    // scan-fnd-shared sweep only catches mints for artists known when
    // its cursor passed their blocks, so on-admission refresh needs this.
    sql.unsafe(
      `INSERT INTO artist_tokens
         (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
       SELECT s.creator, '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405', s.token_id,
              'fnd-shared', s.mint_block, s.mint_log_index, NOW()
       FROM fnd_shared_mints_seed s
       WHERE s.creator = $1
       ON CONFLICT (contract, token_id) DO NOTHING`,
      [lower],
    ),
    // FND collections this artist deployed — Ponder's live factory
    // subscription UNION the pre-window full-history seed (023).
    sql.unsafe(
      `SELECT lower(collection) AS contract, created_at_block::text AS deploy_block
       FROM ${INDEXER_SCHEMA}.fnd_collections WHERE lower(creator) = $1
       UNION
       SELECT collection AS contract, deploy_block::text AS deploy_block
       FROM fnd_collections_seed WHERE creator = $1`,
      [lower],
    ).then(async (rows: unknown) => {
      const list = rows as Array<{ contract: string; deploy_block: string }>
      for (const r of list) {
        await scanArtistTokensViaTransferFromZero({
          sql, client, taskName: "refresh-artist",
          platform: "fnd-collection",
          artist: lower, contract: r.contract,
          contractDeployBlock: BigInt(r.deploy_block),
        })
      }
    }),
    // Mint clones this artist deployed
    sql.unsafe(
      `SELECT lower(contract) AS contract, first_seen_block::text AS deploy_block
       FROM ${INDEXER_SCHEMA}.mint_creators WHERE lower(address) = $1`,
      [lower],
    ).then(async (rows: unknown) => {
      const list = rows as Array<{ contract: string; deploy_block: string }>
      for (const r of list) {
        await scanErc1155MintsFromZero({
          sql, client, taskName: "refresh-artist",
          platform: "mint",
          artist: lower, contract: r.contract,
          contractDeployBlock: BigInt(r.deploy_block),
        })
      }
    }),
    // TL clones this artist deployed
    sql.unsafe(
      `SELECT lower(contract) AS contract, first_seen_block::text AS deploy_block
       FROM ${INDEXER_SCHEMA}.tl_creators WHERE lower(sender) = $1 AND c_type LIKE 'ERC721%'`,
      [lower],
    ).then(async (rows: unknown) => {
      const list = rows as Array<{ contract: string; deploy_block: string }>
      for (const r of list) {
        await scanArtistTokensViaTransferFromZero({
          sql, client, taskName: "refresh-artist",
          platform: "tl",
          artist: lower, contract: r.contract,
          contractDeployBlock: BigInt(r.deploy_block),
        })
      }
    }),
    // Manifold scheduled flow (Path A trace_filter + per-contract scans).
    scanManifoldArtistTokens(lower),
    // Manifold Path B (mints-to-artist). Intentionally NOT in the
    // scheduled scan-manifold task — only fires on artist-triggered
    // refresh and on first-time-known-artists onboarding. Catches new
    // contracts the artist starts using as recipient (Manifold Studio,
    // collabs) that Path A misses.
    discoverMintsToArtist({ artist: lower as Address }),
  ])
}
