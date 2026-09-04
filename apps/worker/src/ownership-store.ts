import type { Sql, TransactionSql } from "postgres"

type OwnershipSql = Sql | TransactionSql

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000"

export type OwnershipCoverage = "complete" | "partial" | "snapshot" | "stale"

export type Erc721OwnershipObservation = {
  contract: string
  tokenId: string
  owner: string
  source: string
  blockNumber: bigint
  logIndex: bigint
  txHash?: string | null
  blockTime?: bigint | null
  finalized: boolean
  coverageStatus: OwnershipCoverage
}

/**
 * Write current ERC-721 ownership with block+log ordering. The migration's
 * trigger mirrors this row into legacy `token_owners`, so callers need one
 * statement and old token/detail queries remain correct.
 *
 * `authoritativeSnapshot` is for a reorg-aware current-state source such as
 * Ponder. It may replace an older observation from the same source after that
 * source rolls back. Event scanners should leave it false.
 */
export async function recordErc721Ownership(
  sql: OwnershipSql,
  observation: Erc721OwnershipObservation,
  authoritativeSnapshot = false,
): Promise<void> {
  const contract = observation.contract.toLowerCase()
  const owner = observation.owner.toLowerCase()
  const blockNumber = observation.blockNumber.toString()
  const logIndex = observation.logIndex.toString()
  const blockTime = observation.blockTime?.toString() ?? null

  if (authoritativeSnapshot) {
    await sql`
      INSERT INTO token_ownership (
        contract, token_id, owner, source, last_block, log_index, tx_hash,
        block_time, observed_at, finalized, coverage_status
      ) VALUES (
        ${contract}, ${observation.tokenId}, ${owner}, ${observation.source},
        ${blockNumber}::bigint, ${logIndex}::bigint,
        ${observation.txHash ?? null}, ${blockTime}::bigint, NOW(),
        ${observation.finalized}, ${observation.coverageStatus}
      )
      ON CONFLICT (contract, token_id) DO UPDATE SET
        owner = EXCLUDED.owner,
        source = EXCLUDED.source,
        last_block = EXCLUDED.last_block,
        log_index = EXCLUDED.log_index,
        tx_hash = EXCLUDED.tx_hash,
        block_time = EXCLUDED.block_time,
        observed_at = EXCLUDED.observed_at,
        finalized = EXCLUDED.finalized,
        coverage_status = EXCLUDED.coverage_status
      WHERE token_ownership.source = EXCLUDED.source
         OR (token_ownership.last_block, token_ownership.log_index)
            <= (EXCLUDED.last_block, EXCLUDED.log_index)
    `
    return
  }

  await sql`
    INSERT INTO token_ownership (
      contract, token_id, owner, source, last_block, log_index, tx_hash,
      block_time, observed_at, finalized, coverage_status
    ) VALUES (
      ${contract}, ${observation.tokenId}, ${owner}, ${observation.source},
      ${blockNumber}::bigint, ${logIndex}::bigint,
      ${observation.txHash ?? null}, ${blockTime}::bigint, NOW(),
      ${observation.finalized}, ${observation.coverageStatus}
    )
    ON CONFLICT (contract, token_id) DO UPDATE SET
      owner = EXCLUDED.owner,
      source = EXCLUDED.source,
      last_block = EXCLUDED.last_block,
      log_index = EXCLUDED.log_index,
      tx_hash = EXCLUDED.tx_hash,
      block_time = EXCLUDED.block_time,
      observed_at = EXCLUDED.observed_at,
      finalized = EXCLUDED.finalized,
      coverage_status = EXCLUDED.coverage_status
    WHERE (token_ownership.last_block, token_ownership.log_index)
          <= (EXCLUDED.last_block, EXCLUDED.log_index)
  `
}

export type Erc1155Amount = {
  tokenId: string | bigint
  amount: string | bigint
}

export type NormalizedErc1155Amount = {
  tokenId: string
  amount: bigint
}

/** Aggregate duplicate ids defensively and reject malformed batch arrays. */
export function normalizeErc1155Amounts(
  entries: readonly Erc1155Amount[],
): NormalizedErc1155Amount[] {
  const totals = new Map<string, bigint>()
  for (const entry of entries) {
    const tokenId = BigInt(entry.tokenId).toString()
    const amount = BigInt(entry.amount)
    if (amount < 0n) throw new Error("ERC-1155 transfer amount cannot be negative")
    if (amount === 0n) continue
    totals.set(tokenId, (totals.get(tokenId) ?? 0n) + amount)
  }
  return [...totals.entries()].map(([tokenId, amount]) => ({ tokenId, amount }))
}

export type Erc1155BalanceDelta = {
  tokenId: string
  holder: string
  delta: bigint
}

/** Pure balance math shared by TransferSingle and expanded TransferBatch. */
export function erc1155BalanceDeltas(
  from: string,
  to: string,
  entries: readonly Erc1155Amount[],
): Erc1155BalanceDelta[] {
  const normalized = normalizeErc1155Amounts(entries)
  const fromLower = from.toLowerCase()
  const toLower = to.toLowerCase()
  if (fromLower === toLower) return []

  const deltas: Erc1155BalanceDelta[] = []
  for (const entry of normalized) {
    if (fromLower !== ZERO_ADDRESS) {
      deltas.push({ tokenId: entry.tokenId, holder: fromLower, delta: -entry.amount })
    }
    if (toLower !== ZERO_ADDRESS) {
      deltas.push({ tokenId: entry.tokenId, holder: toLower, delta: entry.amount })
    }
  }
  return deltas
}

export type Erc1155TransferObservation = {
  contract: string
  from: string
  to: string
  entries: readonly Erc1155Amount[]
  source: string
  blockNumber: bigint
  logIndex: bigint
  txHash: string
  finalized: boolean
  coverageStatus: OwnershipCoverage
}

export type Erc1155TransferResult = {
  eventsApplied: number
  balanceRowsChanged: number
}

/**
 * Apply one TransferSingle or expanded TransferBatch atomically. The event
 * ledger makes overlap replay idempotent. A debit without sufficient indexed
 * balance throws, leaving both events and balances untouched; callers must not
 * advance their range cursor after that failure.
 */
export async function recordErc1155Transfer(
  sql: Sql,
  observation: Erc1155TransferObservation,
): Promise<Erc1155TransferResult> {
  const contract = observation.contract.toLowerCase()
  const from = observation.from.toLowerCase()
  const to = observation.to.toLowerCase()
  const entries = normalizeErc1155Amounts(observation.entries)
  const deltas = erc1155BalanceDeltas(from, to, entries)

  if (entries.length === 0) return { eventsApplied: 0, balanceRowsChanged: 0 }

  return sql.begin(async (tx) => {
    const applied = new Set<string>()
    for (const entry of entries) {
      const inserted = (await tx`
        INSERT INTO token_1155_balance_events (
          contract, token_id, from_addr, to_addr, amount, block_number,
          log_index, tx_hash, source, observed_at, finalized, coverage_status
        ) VALUES (
          ${contract}, ${entry.tokenId}, ${from}, ${to},
          ${entry.amount.toString()}::numeric,
          ${observation.blockNumber.toString()}::bigint,
          ${observation.logIndex.toString()}::bigint,
          ${observation.txHash}, ${observation.source}, NOW(),
          ${observation.finalized}, ${observation.coverageStatus}
        )
        ON CONFLICT (contract, tx_hash, log_index, token_id) DO NOTHING
        RETURNING token_id
      `) as Array<{ token_id: string }>
      if (inserted.length > 0) applied.add(entry.tokenId)
    }

    if (applied.size === 0) {
      return { eventsApplied: 0, balanceRowsChanged: 0 }
    }

    let balanceRowsChanged = 0
    for (const delta of deltas) {
      if (!applied.has(delta.tokenId)) continue

      if (delta.delta < 0n) {
        const current = (await tx`
          SELECT balance::text AS balance
          FROM token_balances_1155
          WHERE contract = ${contract}
            AND token_id = ${delta.tokenId}
            AND holder = ${delta.holder}
          FOR UPDATE
        `) as Array<{ balance: string }>
        const balance = current[0] ? BigInt(current[0].balance) : 0n
        const next = balance + delta.delta
        if (next < 0n) {
          throw new Error(
            `ERC-1155 balance underflow for ${contract}/${delta.tokenId}/${delta.holder}`,
          )
        }
        if (next === 0n) {
          await tx`
            DELETE FROM token_balances_1155
            WHERE contract = ${contract}
              AND token_id = ${delta.tokenId}
              AND holder = ${delta.holder}
          `
        } else {
          await tx`
            UPDATE token_balances_1155 SET
              balance = ${next.toString()}::numeric,
              source = ${observation.source},
              last_block = ${observation.blockNumber.toString()}::bigint,
              log_index = ${observation.logIndex.toString()}::bigint,
              observed_at = NOW(),
              finalized = ${observation.finalized},
              coverage_status = ${observation.coverageStatus}
            WHERE contract = ${contract}
              AND token_id = ${delta.tokenId}
              AND holder = ${delta.holder}
          `
        }
        balanceRowsChanged += 1
        continue
      }

      await tx`
        INSERT INTO token_balances_1155 (
          contract, token_id, holder, balance, source, last_block, log_index,
          observed_at, finalized, coverage_status
        ) VALUES (
          ${contract}, ${delta.tokenId}, ${delta.holder},
          ${delta.delta.toString()}::numeric, ${observation.source},
          ${observation.blockNumber.toString()}::bigint,
          ${observation.logIndex.toString()}::bigint,
          NOW(), ${observation.finalized}, ${observation.coverageStatus}
        )
        ON CONFLICT (contract, token_id, holder) DO UPDATE SET
          balance = token_balances_1155.balance + EXCLUDED.balance,
          source = EXCLUDED.source,
          last_block = EXCLUDED.last_block,
          log_index = EXCLUDED.log_index,
          observed_at = EXCLUDED.observed_at,
          finalized = EXCLUDED.finalized,
          coverage_status = CASE
            WHEN token_balances_1155.coverage_status = 'complete'
             AND EXCLUDED.coverage_status = 'complete' THEN 'complete'
            ELSE EXCLUDED.coverage_status
          END
      `
      balanceRowsChanged += 1
    }

    return { eventsApplied: applied.size, balanceRowsChanged }
  })
}
