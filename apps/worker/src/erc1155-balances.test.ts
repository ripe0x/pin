import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  MalformedTransferError, ZERO_ADDRESS, affectedTokens, balanceKey, computeBalances,
  erc1155ScopesSql, expandTransferLogs, ledgerInsertParams, ledgerKey, recomputeParams,
  type Erc1155Log, type LedgerRow,
} from "./erc1155-balances.ts"

const C = "0xcccccccccccccccccccccccccccccccccccccccc"
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const OP = "0x0000000000000000000000000000000000000001"

let txSeq = 0
const tx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`

function single(from: string, to: string, id: bigint, value: bigint, block: bigint, logIndex = 0): Erc1155Log {
  return {
    address: C.toUpperCase().replace("0X", "0x"), blockNumber: block, logIndex,
    transactionHash: tx(), eventName: "TransferSingle",
    args: { operator: OP, from, to, id, value },
  }
}

function batch(from: string, to: string, ids: bigint[], values: bigint[], block: bigint, logIndex = 0): Erc1155Log {
  return {
    address: C, blockNumber: block, logIndex, transactionHash: tx(), eventName: "TransferBatch",
    args: { operator: OP, from, to, ids, values },
  }
}

/**
 * The scanner's write path, in memory: insert ledger rows keyed like
 * token_1155_transfers' PK (ON CONFLICT DO NOTHING), return only the new
 * rows, and recompute balances of the tokens they touch from the whole
 * ledger (pnd_recompute_token_1155_balances).
 */
class Store {
  ledger = new Map<string, LedgerRow>()
  balances = new Map<string, { balance: bigint; updatedBlock: bigint }>()
  apply(logs: Erc1155Log[]): { inserted: number; recomputed: number } {
    const fresh = expandTransferLogs(logs).filter((r) => {
      const k = ledgerKey(r)
      if (this.ledger.has(k)) return false
      this.ledger.set(k, r)
      return true
    })
    const tokens = affectedTokens(fresh)
    const all = computeBalances(this.ledger.values())
    for (const t of tokens) {
      const prefix = `${t.contract}:${t.tokenId}:`
      for (const k of [...this.balances.keys()]) if (k.startsWith(prefix)) this.balances.delete(k)
      for (const [k, v] of all) if (k.startsWith(prefix)) this.balances.set(k, v)
    }
    return { inserted: fresh.length, recomputed: tokens.length }
  }
  bal(id: bigint, holder: string): bigint | undefined {
    return this.balances.get(balanceKey(C, id.toString(), holder))?.balance
  }
}

test("TransferSingle mint credits the recipient only", () => {
  const s = new Store()
  s.apply([single(ZERO_ADDRESS, A, 1n, 5n, 100n)])
  assert.equal(s.bal(1n, A), 5n)
  assert.equal(s.bal(1n, ZERO_ADDRESS), undefined)
  assert.equal(s.balances.size, 1)
})

test("TransferBatch mint expands to one ledger row per id", () => {
  const s = new Store()
  const r = s.apply([batch(ZERO_ADDRESS, A, [1n, 2n, 3n], [10n, 4n, 1n], 100n)])
  assert.equal(r.inserted, 3)
  assert.equal(s.bal(1n, A), 10n)
  assert.equal(s.bal(2n, A), 4n)
  assert.equal(s.bal(3n, A), 1n)
})

test("a batch repeating an id keeps both entries (batch_index in the key)", () => {
  const rows = expandTransferLogs([batch(ZERO_ADDRESS, A, [7n, 7n], [2n, 3n], 100n)])
  assert.deepEqual(rows.map((r) => r.batchIndex), [0, 1])
  assert.notEqual(ledgerKey(rows[0]), ledgerKey(rows[1]))
  assert.equal(computeBalances(rows).get(balanceKey(C, "7", A))?.balance, 5n)
})

test("transfer between holders moves the balance and updates both blocks", () => {
  const s = new Store()
  s.apply([single(ZERO_ADDRESS, A, 1n, 5n, 100n)])
  s.apply([single(A, B, 1n, 2n, 200n)])
  assert.equal(s.bal(1n, A), 3n)
  assert.equal(s.bal(1n, B), 2n)
  assert.equal(s.balances.get(balanceKey(C, "1", A))?.updatedBlock, 200n)
  assert.equal(s.balances.get(balanceKey(C, "1", B))?.updatedBlock, 200n)
})

test("transferring the whole balance removes the holder's row", () => {
  const s = new Store()
  s.apply([single(ZERO_ADDRESS, A, 1n, 2n, 100n)])
  s.apply([batch(A, B, [1n], [2n], 150n)])
  assert.equal(s.bal(1n, A), undefined)
  assert.equal(s.bal(1n, B), 2n)
})

test("burn debits the holder; burning everything leaves no rows", () => {
  const s = new Store()
  s.apply([single(ZERO_ADDRESS, A, 1n, 3n, 100n)])
  s.apply([single(A, ZERO_ADDRESS, 1n, 1n, 110n)])
  assert.equal(s.bal(1n, A), 2n)
  s.apply([batch(A, ZERO_ADDRESS, [1n], [2n], 120n)])
  assert.equal(s.balances.size, 0)
})

test("a self-transfer nets to zero", () => {
  const s = new Store()
  s.apply([single(ZERO_ADDRESS, A, 1n, 3n, 100n)])
  s.apply([single(A, A, 1n, 3n, 101n)])
  assert.equal(s.bal(1n, A), 3n)
})

test("a replayed range is a no-op: nothing inserted, nothing recomputed", () => {
  const s = new Store()
  const logs = [
    single(ZERO_ADDRESS, A, 1n, 5n, 100n),
    batch(ZERO_ADDRESS, B, [1n, 2n], [1n, 1n], 101n, 3),
    single(A, B, 1n, 2n, 102n),
  ]
  const first = s.apply(logs)
  const snapshot = new Map(s.balances)
  const second = s.apply(logs)
  assert.equal(first.inserted, 4)
  assert.deepEqual(second, { inserted: 0, recomputed: 0 })
  assert.deepEqual(s.balances, snapshot)
  // An overlapping window (last block + new block) applies only the new log.
  const third = s.apply([logs[2], single(B, A, 2n, 1n, 103n)])
  assert.equal(third.inserted, 1)
  assert.equal(s.bal(2n, A), 1n)
  assert.equal(s.bal(2n, B), undefined)
})

test("ranges applied out of order converge to the in-order result", () => {
  const mint = single(ZERO_ADDRESS, A, 1n, 5n, 100n)
  const move = single(A, B, 1n, 5n, 200n)
  const inOrder = new Store()
  inOrder.apply([mint])
  inOrder.apply([move])
  const outOfOrder = new Store()
  outOfOrder.apply([move]) // B +5, A -5 (negative, not stored)
  assert.equal(outOfOrder.bal(1n, A), undefined)
  outOfOrder.apply([mint])
  assert.deepEqual(outOfOrder.balances, inOrder.balances)
})

test("malformed logs fail the range instead of writing a partial ledger", () => {
  assert.throws(
    () => expandTransferLogs([batch(ZERO_ADDRESS, A, [1n, 2n], [1n], 100n)]),
    MalformedTransferError,
  )
  assert.throws(
    () => expandTransferLogs([{ ...single(ZERO_ADDRESS, A, 1n, 1n, 1n), args: {} }]),
    MalformedTransferError,
  )
})

test("addresses are lowercased and uint256 amounts survive the insert params", () => {
  const big = 2n ** 255n + 1n
  const rows = expandTransferLogs([single(ZERO_ADDRESS, A.toUpperCase().replace("0X", "0x"), 9n, big, 5n)])
  assert.equal(rows[0].contract, C)
  assert.equal(rows[0].to, A)
  const params = ledgerInsertParams(rows)
  assert.equal(params.length, 10)
  assert.equal(params[5], `{"${big.toString()}"}`)
  assert.deepEqual(recomputeParams(affectedTokens(rows)), [`{"${C}"}`, `{"9"}`])
})

test("scope query is gated on known_artists and the cursor join", () => {
  const q = erc1155ScopesSql("ponder_v9")
  assert.match(q, /ponder_v9\.mint_creators/)
  assert.match(q, /JOIN known_artists k ON k\.address = lower\(c\.address\)/)
  assert.match(q, /JOIN known_artists k ON k\.address = lower\(mc\.artist\)/)
  assert.match(q, /mc\.is_erc1155/)
  assert.match(q, /w\.task = \$1/)
})
