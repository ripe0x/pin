import assert from "node:assert/strict"
import test from "node:test"
import {
  erc1155BalanceDeltas,
  normalizeErc1155Amounts,
  ZERO_ADDRESS,
  type Erc1155BalanceDelta,
} from "./ownership-store.ts"

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

function apply(
  balances: Map<string, bigint>,
  deltas: readonly Erc1155BalanceDelta[],
): void {
  for (const { tokenId, holder, delta } of deltas) {
    const key = `${tokenId}:${holder}`
    const next = (balances.get(key) ?? 0n) + delta
    assert.ok(next >= 0n, `balance underflow at ${key}`)
    if (next === 0n) balances.delete(key)
    else balances.set(key, next)
  }
}

test("normalizes a TransferBatch and aggregates duplicate ids", () => {
  assert.deepEqual(
    normalizeErc1155Amounts([
      { tokenId: 1n, amount: 2n },
      { tokenId: "2", amount: "3" },
      { tokenId: 1n, amount: 4n },
      { tokenId: 3n, amount: 0n },
    ]),
    [
      { tokenId: "1", amount: 6n },
      { tokenId: "2", amount: 3n },
    ],
  )
})

test("mint, transfer, and burn converge and remove zero balances", () => {
  const balances = new Map<string, bigint>()

  apply(balances, erc1155BalanceDeltas(ZERO_ADDRESS, A, [
    { tokenId: 7n, amount: 5n },
  ]))
  apply(balances, erc1155BalanceDeltas(A, B, [
    { tokenId: 7n, amount: 2n },
  ]))
  apply(balances, erc1155BalanceDeltas(A, ZERO_ADDRESS, [
    { tokenId: 7n, amount: 3n },
  ]))

  assert.deepEqual([...balances.entries()], [[`7:${B}`, 2n]])
})

test("batch transfers update every token and preserve holder totals", () => {
  const balances = new Map<string, bigint>()
  const batch = [
    { tokenId: 1n, amount: 10n },
    { tokenId: 2n, amount: 4n },
  ]

  apply(balances, erc1155BalanceDeltas(ZERO_ADDRESS, A, batch))
  apply(balances, erc1155BalanceDeltas(A, B, batch))

  assert.deepEqual([...balances.entries()].sort(), [
    [`1:${B}`, 10n],
    [`2:${B}`, 4n],
  ])
})

test("self-transfers do not change balances", () => {
  assert.deepEqual(
    erc1155BalanceDeltas(A.toUpperCase(), A, [{ tokenId: 1n, amount: 9n }]),
    [],
  )
})

test("negative transfer amounts fail loudly", () => {
  assert.throws(
    () => normalizeErc1155Amounts([{ tokenId: 1n, amount: -1n }]),
    /cannot be negative/,
  )
})
