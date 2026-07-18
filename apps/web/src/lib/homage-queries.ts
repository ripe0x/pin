import "server-only"
import { sql } from "./db"

/**
 * Read-side queries against the Homage tables Ponder writes (`homage_tokens`,
 * `homage_activity`, `homage_config`). Mirrors `indexer-queries.ts`: every
 * export has a hard timeout and returns an empty/null value on miss or failure.
 *
 * **These tables DO NOT EXIST in prod until the Homage indexer version deploys**
 * (the contract isn't live yet). Until then every read here hits a schema that
 * has no `homage_*` relation, so Postgres raises `42P01 relation does not
 * exist`. `withTimeout`'s try/catch swallows that (verified against maglev),
 * so callers see "no data" and degrade to the existing RPC snapshot path. This
 * is the same additive contract the rest of the indexer reads follow, which is
 * what lets this branch ship before the contract exists.
 *
 * Kill switch (identical to indexer-queries.ts):
 *   1. `DATABASE_URL` unset → `sql` is null → all return empty.
 *   2. `INDEXER_DISABLED=1` → all return empty even when DB is up.
 *   3. Per-query timeout → slow indexer reads bail to RPC fallback.
 */

const INDEXER_DISABLED = process.env.INDEXER_DISABLED === "1"
const QUERY_TIMEOUT_MS = 500

/** Sanitized indexer schema name for safe interpolation into unsafe() SQL. */
function indexerSchema(): string {
  return (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(/[^a-zA-Z0-9_]/g, "")
}

/**
 * Race a query against a timeout. Returns `null` on timeout, DB error, or a
 * missing relation (pre-deploy). Same shape as indexer-queries.ts:withTimeout.
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── config (schedule + fee knobs) ────────────────────────────────────────────

/**
 * The indexed on-chain schedule + fee config for a Homage contract. All
 * timestamps/amounts are decimal strings (bigint-safe across the RSC boundary);
 * null means the setter event hasn't been indexed (or the tables don't exist).
 */
export type HomageConfig = {
  claimStart: string | null
  allowlistStart: string | null
  publicStart: string | null
  allowlistRoot: string | null
  maxPerAllowlisted: string | null
  baseFee: string | null
  feeGrowthBps: string | null
  exitFee: string | null
}

/**
 * The indexed schedule/config row for `contract`, or null when the tables are
 * absent / unsynced / the timeout trips. Callers fall back to the RPC snapshot.
 */
export async function getHomageConfig(contract: string): Promise<HomageConfig | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = indexerSchema()
    const rows = (await db.unsafe(
      `SELECT claim_start::text          AS claim_start,
              allowlist_start::text      AS allowlist_start,
              public_start::text         AS public_start,
              allowlist_root             AS allowlist_root,
              max_per_allowlisted::text  AS max_per_allowlisted,
              base_fee::text             AS base_fee,
              fee_growth_bps::text       AS fee_growth_bps,
              exit_fee::text             AS exit_fee
       FROM ${schema}.homage_config
       WHERE lower(contract) = $1
       LIMIT 1`,
      [contract.toLowerCase()],
    )) as Array<{
      claim_start: string | null
      allowlist_start: string | null
      public_start: string | null
      allowlist_root: string | null
      max_per_allowlisted: string | null
      base_fee: string | null
      fee_growth_bps: string | null
      exit_fee: string | null
    }>
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      claimStart: r.claim_start,
      allowlistStart: r.allowlist_start,
      publicStart: r.public_start,
      allowlistRoot: r.allowlist_root,
      maxPerAllowlisted: r.max_per_allowlisted,
      baseFee: r.base_fee,
      feeGrowthBps: r.fee_growth_bps,
      exitFee: r.exit_fee,
    }
  })
}

// ── supply (outstanding count) ───────────────────────────────────────────────

/**
 * The number of currently-outstanding homages (rows with `outstanding = true`).
 * Churn-aware: a redeem flips the row false, so this reflects the live pool.
 * Returns null when the tables are absent / unsynced — caller uses the RPC
 * `totalMinted` snapshot instead.
 */
export async function getHomageOutstandingCount(contract: string): Promise<number | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = indexerSchema()
    const rows = (await db.unsafe(
      `SELECT count(*)::text AS n
       FROM ${schema}.homage_tokens
       WHERE outstanding = true`,
    )) as Array<{ n: string }>
    if (rows.length === 0) return null
    return Number(rows[0].n)
  })
}

// ── provenance (per-token activity timeline) ─────────────────────────────────

export type HomageActivityType = "mint" | "claim" | "redeem" | "transfer"

/** One row of a token's provenance history, newest-first as returned. */
export type HomageActivityEntry = {
  type: HomageActivityType
  from: string | null
  to: string | null
  /** Present on mint/claim (ethSwapped/received111) and redeem (amount111). */
  ethSwapped: bigint | null
  received111: bigint | null
  amount111: bigint | null
  /** "claim" | "allowlist" | "public" for mint/claim rows; null otherwise. */
  mintPhase: string | null
  blockTime: number
  txHash: string
}

/**
 * Every activity row for a punkId, oldest-first (mint → transfers/redeems →
 * re-mints — the churn IS the story). Pure Postgres, hits the
 * `(punkId, blockNumber)` index. Returns `[]` on miss / unavailable so the
 * token page simply omits the timeline pre-deploy.
 */
export async function getHomageProvenance(
  contract: string,
  punkId: string,
): Promise<HomageActivityEntry[]> {
  if (INDEXER_DISABLED || !sql) return []
  const db = sql

  const result = await withTimeout(async () => {
    const schema = indexerSchema()
    // `contract` is not a column on homage_activity (the table is single-
    // collection — one Homage singleton), so we filter by punkId only. Kept in
    // the signature for parity + future multi-contract shape.
    void contract
    const rows = (await db.unsafe(
      `SELECT type,
              "from"                AS from_addr,
              "to"                  AS to_addr,
              eth_swapped::text     AS eth_swapped,
              received111::text     AS received111,
              amount111::text       AS amount111,
              mint_phase            AS mint_phase,
              block_time::text      AS block_time,
              tx_hash               AS tx_hash
       FROM ${schema}.homage_activity
       WHERE punk_id = $1::numeric
       ORDER BY block_number ASC, log_index ASC`,
      [punkId],
    )) as Array<{
      type: string
      from_addr: string | null
      to_addr: string | null
      eth_swapped: string | null
      received111: string | null
      amount111: string | null
      mint_phase: string | null
      block_time: string
      tx_hash: string
    }>
    return rows.map((r) => ({
      type: r.type as HomageActivityType,
      from: r.from_addr,
      to: r.to_addr,
      ethSwapped: r.eth_swapped != null ? BigInt(r.eth_swapped) : null,
      received111: r.received111 != null ? BigInt(r.received111) : null,
      amount111: r.amount111 != null ? BigInt(r.amount111) : null,
      mintPhase: r.mint_phase,
      blockTime: Number(r.block_time),
      txHash: r.tx_hash,
    }))
  })

  return result ?? []
}

// ── gallery (outstanding token ids) ──────────────────────────────────────────

/**
 * The punkIds of every currently-outstanding homage, ascending. Backs the
 * gallery so we never enumerate 10k tokens on-chain: the indexer already knows
 * which ids exist, and the (short-TTL cached) tokenURI reads only fire for
 * those ids. Returns `[]` on miss so the gallery degrades to the RPC path.
 * `limit` caps the page (large collections paginate — a follow-up).
 */
export async function getHomageOutstandingIds(
  contract: string,
  limit = 500,
): Promise<number[]> {
  if (INDEXER_DISABLED || !sql) return []
  const db = sql

  const result = await withTimeout(async () => {
    const schema = indexerSchema()
    void contract
    const rows = (await db.unsafe(
      `SELECT punk_id::text AS punk_id
       FROM ${schema}.homage_tokens
       WHERE outstanding = true
       ORDER BY punk_id ASC
       LIMIT $1`,
      [limit],
    )) as Array<{ punk_id: string }>
    return rows.map((r) => Number(r.punk_id))
  })

  return result ?? []
}

// ── wallet-wide owned homages (redeem discovery) ─────────────────────────────

/** A single outstanding homage held by a wallet, for the "your homages" list. */
export type OwnedHomage = {
  punkId: number
  mintPhase: string | null
  lastMintedAtTime: number
}

/**
 * Every outstanding homage currently held by `wallet`, ascending by punkId.
 * Hits the `holder` index. Powers the redeem-discovery list ("your homages")
 * without any wallet-side log scan. Returns `[]` on miss / unavailable.
 */
export async function getOwnedHomages(
  contract: string,
  wallet: string,
): Promise<OwnedHomage[]> {
  if (INDEXER_DISABLED || !sql) return []
  const db = sql

  const result = await withTimeout(async () => {
    const schema = indexerSchema()
    void contract
    const rows = (await db.unsafe(
      `SELECT punk_id::text          AS punk_id,
              mint_phase             AS mint_phase,
              last_minted_at_time::text AS last_minted_at_time
       FROM ${schema}.homage_tokens
       WHERE outstanding = true AND lower(holder) = $1
       ORDER BY punk_id ASC`,
      [wallet.toLowerCase()],
    )) as Array<{
      punk_id: string
      mint_phase: string | null
      last_minted_at_time: string
    }>
    return rows.map((r) => ({
      punkId: Number(r.punk_id),
      mintPhase: r.mint_phase,
      lastMintedAtTime: Number(r.last_minted_at_time),
    }))
  })

  return result ?? []
}
