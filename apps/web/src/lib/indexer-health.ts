import "server-only"
import { sql } from "./db"
import { pgCache } from "./pg-cache"
import { withTimeout } from "./indexer-queries"
import { INDEXER_SCHEMA } from "./indexer-schema"
import { isFreshnessStale, STALE_THRESHOLD_SEC } from "./indexer-freshness-status"

export { STALE_THRESHOLD_SEC }

export type IndexerFreshness = {
  schema: string
  latestBlock: number
  latestBlockTime: number // unix seconds
  ageSeconds: number
}

const FRESHNESS_CACHE_TTL_SEC = 60
const FRESHNESS_TIMEOUT_MS = 2_000

/**
 * Decodes Ponder's `_ponder_checkpoint` string (see
 * ponder/src/utils/checkpoint.ts: 10-digit block timestamp + 16-digit
 * chain id + 16-digit block number + ...). Fixed-width zero-padded
 * fields sort and slice safely as plain strings.
 */
async function readCheckpointFreshness(): Promise<{ block: number; time: number } | null> {
  if (!sql) return null
  const rows = (await sql.unsafe(
    `SELECT substring(latest_checkpoint, 1, 10)::bigint AS block_ts,
            substring(latest_checkpoint, 27, 16)::bigint AS block_number
     FROM ${INDEXER_SCHEMA}._ponder_checkpoint
     ORDER BY latest_checkpoint DESC
     LIMIT 1`,
  )) as Array<{ block_ts: string; block_number: string }>
  const row = rows[0]
  if (!row) return null
  return { block: Number(row.block_number), time: Number(row.block_ts) }
}

/**
 * Fallback when the checkpoint table is missing or an unexpected shape:
 * the newest activity actually written into the auction tables. Coarser
 * than the checkpoint (reflects auction/bid events, not the indexer's
 * live head), but still catches a schema that has stopped indexing.
 */
async function readAuctionActivityFreshness(): Promise<{ block: number; time: number } | null> {
  if (!sql) return null
  const rows = (await sql.unsafe(
    `SELECT GREATEST(
       (SELECT COALESCE(MAX(created_at_time), 0) FROM ${INDEXER_SCHEMA}.pnd_auctions),
       (SELECT COALESCE(MAX(block_time), 0) FROM ${INDEXER_SCHEMA}.pnd_bids)
     )::bigint AS block_ts,
     GREATEST(
       (SELECT COALESCE(MAX(created_at_block), 0) FROM ${INDEXER_SCHEMA}.pnd_auctions),
       (SELECT COALESCE(MAX(block_number), 0) FROM ${INDEXER_SCHEMA}.pnd_bids)
     )::bigint AS block_number`,
  )) as Array<{ block_ts: string; block_number: string }>
  const row = rows[0]
  if (!row || Number(row.block_ts) === 0) return null
  return { block: Number(row.block_number), time: Number(row.block_ts) }
}

// Logged at most once per process — a stale schema is a standing incident,
// not something to re-announce on every request.
let warnedStale = false

/**
 * Freshness of the schema `INDEXER_SCHEMA` points at, pgCache-wrapped
 * (60s TTL) and timeboxed so a slow/unreachable Postgres never adds
 * latency. Returns null on any failure — never throws.
 *
 * The cache key is scoped to `INDEXER_SCHEMA`: `cache_entries` is a
 * shared Postgres table, so a schema-less key would let a reading cached
 * under one schema keep answering for a different schema for up to
 * `FRESHNESS_CACHE_TTL_SEC` after an env flip, which is the exact class
 * of stale-schema bug this module exists to catch.
 */
export async function getIndexerFreshness(): Promise<IndexerFreshness | null> {
  const freshness = await pgCache(
    `indexer-freshness:${INDEXER_SCHEMA}`,
    FRESHNESS_CACHE_TTL_SEC,
    () =>
      withTimeout(async () => {
        const result =
          (await readCheckpointFreshness().catch(() => null)) ??
          (await readAuctionActivityFreshness().catch(() => null))
        if (!result) return null
        const freshness: IndexerFreshness = {
          schema: INDEXER_SCHEMA,
          latestBlock: result.block,
          latestBlockTime: result.time,
          ageSeconds: Math.max(0, Math.floor(Date.now() / 1000) - result.time),
        }
        return freshness
      }, FRESHNESS_TIMEOUT_MS),
  )

  if (freshness && isFreshnessStale(freshness.ageSeconds) && !warnedStale) {
    warnedStale = true
    console.error(
      `[indexer] schema ${freshness.schema} is stale: last block ${freshness.latestBlock} at ${new Date(freshness.latestBlockTime * 1000).toISOString()}`,
    )
  }

  return freshness
}
