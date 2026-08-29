import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { PublicClient } from "viem"

let getFinalizedBoundary: typeof import("./finality.ts").getFinalizedBoundary

before(async () => {
  process.env.RPC_DELAY_MS = "0"
  ;({ getFinalizedBoundary } = await import("./finality.ts"))
})

after(() => {
  delete process.env.RPC_DELAY_MS
})

test("uses the RPC finalized boundary when supported", async () => {
  let headCalls = 0
  const client = {
    getBlock: async () => ({ number: 1_000n }),
    getBlockNumber: async () => {
      headCalls += 1
      return 2_000n
    },
  } as unknown as PublicClient

  assert.deepEqual(await getFinalizedBoundary(client), {
    blockNumber: 1_000n,
    rpcCalls: 1,
    source: "finalized",
  })
  assert.equal(headCalls, 0)
})

test("falls back to a confirmation boundary when finalized is unsupported", async () => {
  const client = {
    getBlock: async () => {
      throw new Error("unsupported block tag")
    },
    getBlockNumber: async () => 1_000n,
  } as unknown as PublicClient

  assert.deepEqual(await getFinalizedBoundary(client), {
    blockNumber: 936n,
    rpcCalls: 2,
    source: "confirmations",
  })
})

test("never treats a shallow head as finalized after fallback", async () => {
  const client = {
    getBlock: async () => {
      throw new Error("unsupported block tag")
    },
    getBlockNumber: async () => 64n,
  } as unknown as PublicClient

  await assert.rejects(
    getFinalizedBoundary(client),
    /cannot derive finalized boundary at head 64/,
  )
})
