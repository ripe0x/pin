/**
 * ERC-1155 holder balances: log expansion, the ledger write, and the
 * balance rule (#296, migration 034).
 *
 * scan-1155-balances fetches every TransferSingle / TransferBatch on the
 * ERC-1155 contracts known artists deployed and, per fetched range, in
 * one transaction:
 *   1. expands the logs into ledger rows (`expandTransferLogs`): one row
 *      per TransferSingle, one per array position of a TransferBatch,
 *      keyed (tx_hash, log_index, batch_index);
 *   2. inserts them into token_1155_transfers with ON CONFLICT DO NOTHING,
 *      RETURNING only the rows that were new;
 *   3. recomputes the balances of exactly the tokens those new rows touch
 *      (`pnd_recompute_token_1155_balances`, migration 034).
 *
 * Why recompute-from-ledger instead of applying +/- deltas per log:
 * deltas are only correct if each log is applied exactly once and (with a
 * CHECK balance > 0) in order. The scanner deliberately re-reads logs
 * (the replay overlap below each cursor, group members that start below
 * their group, a range retried after a failed commit). The ledger's
 * primary key makes every re-read a no-op, and since a balance is a pure
 * function of the ledger, the result can't depend on how often or in
 * what order ranges were read. Reorgs are out of scope by construction:
 * the scanner reads finalized blocks only (finality.ts), so no ledger row
 * ever needs removing.
 *
 * `computeBalances` is the reference implementation of the SQL function,
 * used by the unit tests (and checked against the SQL in PGlite).
 *
 * Pure module (no db/rpc imports).
 */
import { toPgTextArray } from "./backoff.ts"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/** A decoded TransferSingle / TransferBatch log, as viem returns it. */
export type Erc1155Log = {
  address: string
  blockNumber: bigint
  logIndex: number
  transactionHash: string
  eventName?: string
  args: {
    operator?: string
    from?: string
    to?: string
    id?: bigint
    value?: bigint
    ids?: readonly bigint[]
    values?: readonly bigint[]
  }
}

export type LedgerRow = {
  contract: string
  tokenId: string
  operator: string
  from: string
  to: string
  amount: bigint
  blockNumber: bigint
  logIndex: number
  /** 0 for TransferSingle; array position for TransferBatch. */
  batchIndex: number
  txHash: string
}

export class MalformedTransferError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MalformedTransferError"
  }
}

const lc = (a: string | undefined): string => (a ?? "").toLowerCase()

/**
 * Ledger rows for a fetched range. Throws MalformedTransferError for a log
 * this scanner can't account for (a batch whose ids/values lengths differ,
 * missing from/to): scan-range then treats the range as failed rather than
 * silently writing a partial ledger.
 */
export function expandTransferLogs(logs: readonly Erc1155Log[]): LedgerRow[] {
  const out: LedgerRow[] = []
  for (const log of logs) {
    const { args } = log
    const where = `${log.address} tx ${log.transactionHash} log ${log.logIndex}`
    if (args.from === undefined || args.to === undefined) {
      throw new MalformedTransferError(`${where}: missing from/to`)
    }
    const base = {
      contract: log.address.toLowerCase(),
      operator: lc(args.operator),
      from: lc(args.from),
      to: lc(args.to),
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      txHash: log.transactionHash.toLowerCase(),
    }
    const isBatch = log.eventName === "TransferBatch" || (args.ids !== undefined && args.id === undefined)
    if (!isBatch) {
      if (args.id === undefined || args.value === undefined) {
        throw new MalformedTransferError(`${where}: TransferSingle without id/value`)
      }
      out.push({ ...base, tokenId: args.id.toString(), amount: args.value, batchIndex: 0 })
      continue
    }
    const ids = args.ids ?? []
    const values = args.values ?? []
    if (ids.length !== values.length) {
      throw new MalformedTransferError(
        `${where}: TransferBatch ids/values length mismatch (${ids.length} vs ${values.length})`,
      )
    }
    for (let i = 0; i < ids.length; i++) {
      out.push({ ...base, tokenId: ids[i].toString(), amount: values[i], batchIndex: i })
    }
  }
  return out
}

/** The ledger primary key (token_1155_transfers). */
export function ledgerKey(r: Pick<LedgerRow, "txHash" | "logIndex" | "batchIndex">): string {
  return `${r.txHash}:${r.logIndex}:${r.batchIndex}`
}

/** Distinct (contract, tokenId) pairs touched by `rows`, sorted. */
export function affectedTokens(
  rows: ReadonlyArray<{ contract: string; tokenId: string }>,
): Array<{ contract: string; tokenId: string }> {
  const seen = new Map<string, { contract: string; tokenId: string }>()
  for (const r of rows) seen.set(`${r.contract}:${r.tokenId}`, { contract: r.contract, tokenId: r.tokenId })
  return Array.from(seen.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => v)
}

export type Balance = { balance: bigint; updatedBlock: bigint }

/** `${contract}:${tokenId}:${holder}` */
export function balanceKey(contract: string, tokenId: string, holder: string): string {
  return `${contract}:${tokenId}:${holder}`
}

/**
 * Reference implementation of pnd_recompute_token_1155_balances: for
 * every (contract, token, holder), Σ received − Σ sent over the ledger,
 * zero address excluded on both sides, only positive results kept;
 * updatedBlock is the last ledger block touching that holder's balance.
 */
export function computeBalances(rows: Iterable<LedgerRow>): Map<string, Balance> {
  const acc = new Map<string, Balance>()
  const add = (r: LedgerRow, holder: string, delta: bigint) => {
    const k = balanceKey(r.contract, r.tokenId, holder)
    const cur = acc.get(k)
    acc.set(k, {
      balance: (cur?.balance ?? 0n) + delta,
      updatedBlock: cur && cur.updatedBlock > r.blockNumber ? cur.updatedBlock : r.blockNumber,
    })
  }
  for (const r of rows) {
    if (r.to !== ZERO_ADDRESS) add(r, r.to, r.amount)
    if (r.from !== ZERO_ADDRESS) add(r, r.from, -r.amount)
  }
  for (const [k, v] of acc) if (v.balance <= 0n) acc.delete(k)
  return acc
}

/**
 * Insert a range's ledger rows; returns only the rows that were new.
 * Parameters are parallel arrays (unnest) passed as Postgres array
 * literals, so every value survives postgres.js' string params exactly
 * (uint256 amounts too).
 */
export const LEDGER_INSERT_SQL =
  `INSERT INTO token_1155_transfers
     (contract, token_id, operator, from_addr, to_addr, amount,
      block_number, log_index, batch_index, tx_hash)
   SELECT * FROM unnest(
     $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[],
     $7::bigint[], $8::bigint[], $9::int[], $10::text[]
   )
   ON CONFLICT (tx_hash, log_index, batch_index) DO NOTHING
   RETURNING contract, token_id`

export function ledgerInsertParams(rows: readonly LedgerRow[]): string[] {
  return [
    rows.map((r) => r.contract),
    rows.map((r) => r.tokenId),
    rows.map((r) => r.operator),
    rows.map((r) => r.from),
    rows.map((r) => r.to),
    rows.map((r) => r.amount.toString()),
    rows.map((r) => r.blockNumber.toString()),
    rows.map((r) => String(r.logIndex)),
    rows.map((r) => String(r.batchIndex)),
    rows.map((r) => r.txHash),
  ].map(toPgTextArray)
}

/** Parameters for RECOMPUTE_SQL. */
export function recomputeParams(tokens: ReadonlyArray<{ contract: string; tokenId: string }>): string[] {
  return [toPgTextArray(tokens.map((t) => t.contract)), toPgTextArray(tokens.map((t) => t.tokenId))]
}

export const RECOMPUTE_SQL =
  "SELECT public.pnd_recompute_token_1155_balances($1::text[], $2::text[]) AS changed"

/**
 * The ERC-1155 contracts in scope, one row per contract with the block
 * its ledger starts at. Only contracts a KNOWN artist deployed:
 *   - Mint protocol clones (mint_creators; every Mint clone is ERC-1155),
 *     from the clone's creation block;
 *   - Manifold Creator Cores the artist deployed and scan-manifold
 *     classified is_erc1155, from the earliest known mint on the contract
 *     (the first event any ERC-1155 emits is a mint; the classification
 *     cache has no deploy block). A contract with no positive mint block
 *     yet is skipped until scan-manifold finds one.
 * Contracts an artist merely minted on (shared storefronts) are out of
 * scope on purpose: scanning those is the unbounded workload the
 * known_artists ceiling exists to prevent. TL ERC-1155 clones are out of
 * scope for the same reason scan-tl-clones skips them: PND doesn't index
 * their tokens yet. $1 = task name for the cursor join.
 */
export function erc1155ScopesSql(schema: string): string {
  return `SELECT s.contract, MIN(s.start_block)::text AS start_block,
                 w.last_block::text AS last_block
     FROM (
       SELECT lower(c.contract) AS contract, c.first_seen_block::bigint AS start_block
       FROM ${schema}.mint_creators c
       JOIN known_artists k ON k.address = lower(c.address)
       UNION ALL
       SELECT mc.contract,
              (SELECT MIN(a.mint_block) FROM artist_tokens a
                WHERE a.contract = mc.contract AND a.mint_block > 0)
       FROM manifold_contracts mc
       JOIN known_artists k ON k.address = lower(mc.artist)
       WHERE mc.is_erc1155
     ) s
     LEFT JOIN worker_cursors w ON w.task = $1 AND w.scope = s.contract
     WHERE s.start_block IS NOT NULL
     GROUP BY s.contract, w.last_block
     ORDER BY s.contract`
}
