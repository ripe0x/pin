import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  getLogsValidationError,
  MAX_RPC_BATCH_SIZE,
  MAX_RPC_REQUEST_BODY_BYTES,
  readRpcBodyWithinLimit,
} from "./rpc-request-guard.ts"

test("RPC batch and body limits remain deliberately bounded", () => {
  assert.equal(MAX_RPC_BATCH_SIZE, 20)
  assert.equal(MAX_RPC_REQUEST_BODY_BYTES, 64 * 1024)
})

test("eth_getLogs accepts bounded numeric ranges", () => {
  assert.equal(
    getLogsValidationError([{ fromBlock: "0x100", toBlock: "0x200" }]),
    null,
  )
  assert.match(
    getLogsValidationError([{ fromBlock: "0x1", toBlock: "0x10000" }]) ?? "",
    /range exceeds/,
  )
})

test("eth_getLogs rejects unbounded and reversed mixed ranges", () => {
  assert.match(
    getLogsValidationError([{ fromBlock: "earliest", toBlock: "latest" }]) ?? "",
    /explicit numeric bounds/,
  )
  assert.match(
    getLogsValidationError([{ fromBlock: "0x20", toBlock: "0x10" }]) ?? "",
    /explicit numeric bounds/,
  )
})

test("RPC request reader rejects declared oversized bodies", async () => {
  const req = new Request("https://example.test/api/rpc", {
    method: "POST",
    headers: { "content-length": String(MAX_RPC_REQUEST_BODY_BYTES + 1) },
    body: "{}",
  })
  await assert.rejects(readRpcBodyWithinLimit(req), /request body too large/)
})

test("RPC request reader rejects streamed oversized bodies", async () => {
  const req = new Request("https://example.test/api/rpc", {
    method: "POST",
    body: "x".repeat(MAX_RPC_REQUEST_BODY_BYTES + 1),
  })
  await assert.rejects(readRpcBodyWithinLimit(req), /request body too large/)
})
