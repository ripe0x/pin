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
import { getFinalizedBoundary } from "../finality.ts"

export type RefreshSourceResult = {
  status: "complete" | "failed"
  added: number
  total: number
  error?: string
}

export type RefreshArtistResult = {
  status: "complete" | "partial" | "failed"
  addedTotal: number
  sources: Record<string, RefreshSourceResult>
}

export async function refreshArtist(address: string): Promise<RefreshArtistResult> {
  const lower = address.toLowerCase()

  // Gate on known_artists; nothing scans for an unknown address.
  const known = (await sql`
    SELECT 1 FROM known_artists WHERE address = ${lower} LIMIT 1
  `) as Array<{ "?column?": number }>
  if (known.length === 0) {
    throw new Error(`${lower} is not in known_artists`)
  }
  const boundary = await getFinalizedBoundary(client)

  const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
    /[^a-zA-Z0-9_]/g, "",
  )

  const runSource = async (
    name: string,
    platforms: string[],
    run: () => Promise<unknown>,
  ): Promise<[string, RefreshSourceResult]> => {
    const beforeRows = (await sql`
      SELECT count(*)::int AS n FROM artist_tokens
      WHERE artist = ${lower} AND platform = ANY(${platforms}::text[])
    `) as Array<{ n: number }>
    const before = beforeRows[0]?.n ?? 0
    try {
      await run()
      const afterRows = (await sql`
        SELECT count(*)::int AS n FROM artist_tokens
        WHERE artist = ${lower} AND platform = ANY(${platforms}::text[])
      `) as Array<{ n: number }>
      const total = afterRows[0]?.n ?? before
      return [name, { status: "complete", added: Math.max(0, total - before), total }]
    } catch (error) {
      return [name, {
        status: "failed",
        added: 0,
        total: before,
        error: error instanceof Error ? error.message : String(error),
      }]
    }
  }

  const entries = await Promise.all([
    // FND shared 1/1s: copy this artist's historical mints from the
    // frozen seed (migration 023). Pure SQL, zero RPC — the scheduled
    // scan-fnd-shared sweep only catches mints for artists known when
    // its cursor passed their blocks, so on-admission refresh needs this.
    runSource("Foundation", ["fnd-shared", "fnd-collection"], async () => sql.unsafe(
      `INSERT INTO artist_tokens
         (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
       SELECT s.creator, '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405', s.token_id,
              'fnd-shared', s.mint_block, s.mint_log_index, NOW()
       FROM fnd_shared_mints_seed s
       WHERE s.creator = $1
      ON CONFLICT (contract, token_id) DO NOTHING`,
      [lower],
    ).then(async () => {
      const rows = await sql.unsafe(
        `SELECT lower(collection) AS contract, created_at_block::text AS deploy_block
         FROM ${INDEXER_SCHEMA}.fnd_collections WHERE lower(creator) = $1
         UNION
         SELECT collection AS contract, deploy_block::text AS deploy_block
         FROM fnd_collections_seed WHERE creator = $1`,
        [lower],
      ) as Array<{ contract: string; deploy_block: string }>
      for (const row of rows) {
        await scanArtistTokensViaTransferFromZero({
          sql, client, taskName: "refresh-artist",
          platform: "fnd-collection", artist: lower, contract: row.contract,
          contractDeployBlock: BigInt(row.deploy_block),
          finalizedBlock: boundary.blockNumber,
        })
      }
    })),
    // FND collections this artist deployed — Ponder's live factory
    // subscription UNION the pre-window full-history seed (023).
    // Mint clones this artist deployed
    runSource("Mint", ["mint"], async () => sql.unsafe(
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
          finalizedBlock: boundary.blockNumber,
        })
      }
    })),
    // TL clones this artist deployed
    runSource("Transient Labs", ["tl"], async () => sql.unsafe(
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
          finalizedBlock: boundary.blockNumber,
        })
      }
    })),
    runSource("Manifold", ["manifold"], async () => {
      await scanManifoldArtistTokens(lower, boundary.blockNumber)
      await discoverMintsToArtist({
        artist: lower as Address,
        finalizedBlock: boundary.blockNumber,
      })
    }),
  ])

  const sources = Object.fromEntries(entries)
  const sourceResults = Object.values(sources)
  const successes = sourceResults.filter(({ status }) => status === "complete").length
  const status = successes === sourceResults.length
    ? "complete"
    : successes === 0
      ? "failed"
      : "partial"
  return {
    status,
    addedTotal: sourceResults.reduce((sum, source) => sum + source.added, 0),
    sources,
  }
}
