import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  attemptTimeoutMs,
  checkRpcEntry,
  gasCapError,
  isAllowedRpcOrigin,
  MAX_RPC_CALL_GAS,
  mergeBatchResponses,
  rpcErrorResponse,
  selectUpstreams,
} from "./rpc-request-guard.ts"

test("eth_call / eth_estimateGas gas is capped", () => {
  assert.equal(MAX_RPC_CALL_GAS, 50_000_000n)
  assert.equal(gasCapError("eth_call", [{ to: "0x1", data: "0x" }, "latest"]), null)
  assert.equal(gasCapError("eth_call", [{ gas: "0x2faf080" }]), null) // exactly 50M
  assert.match(gasCapError("eth_call", [{ gas: "0x2faf081" }]) ?? "", /gas exceeds/)
  assert.match(gasCapError("eth_estimateGas", [{ gas: "0x11e1a300" }]) ?? "", /gas exceeds/)
  assert.match(gasCapError("eth_call", [{ gas: 300000000 }]) ?? "", /hex quantity/)
  // Other methods are not gas-checked.
  assert.equal(gasCapError("eth_getBalance", [{ gas: "0xffffffffff" }]), null)
})

test("entry check enforces the method allowlist, getLogs bounds, and gas cap", () => {
  assert.equal(checkRpcEntry({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }).ok, true)

  const banned = checkRpcEntry({ jsonrpc: "2.0", id: 2, method: "eth_sendTransaction" })
  assert.equal(banned.ok, false)
  if (!banned.ok) {
    assert.equal(banned.error.id, 2)
    assert.equal(banned.error.error.code, -32601)
  }

  const logs = checkRpcEntry({
    jsonrpc: "2.0",
    id: "a",
    method: "eth_getLogs",
    params: [{ fromBlock: "earliest", toBlock: "latest" }],
  })
  assert.equal(logs.ok, false)
  if (!logs.ok) assert.equal(logs.error.id, "a")

  const gas = checkRpcEntry({
    jsonrpc: "2.0",
    id: 3,
    method: "eth_call",
    params: [{ to: "0x1", gas: "0x11e1a300" }, "latest"],
  })
  assert.equal(gas.ok, false)
  if (!gas.ok) assert.equal(gas.error.error.code, -32602)

  const bad = checkRpcEntry([1, 2])
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.error.id, null)
})

test("eth_getLogs is never routed to paid upstreams", () => {
  const ups = [
    { url: "https://public.example", paid: false },
    { url: "https://paid.example", paid: true },
  ]
  assert.deepEqual(
    selectUpstreams(ups, ["eth_call", "eth_getLogs"]).map((u) => u.url),
    ["https://public.example"],
  )
  assert.deepEqual(
    selectUpstreams(ups, ["eth_call"]).map((u) => u.url),
    ["https://public.example", "https://paid.example"],
  )
})

test("origin check accepts this site and rejects other origins", () => {
  assert.equal(
    isAllowedRpcOrigin({ origin: "https://pnd.fyi", referer: null, host: "pnd.fyi" }),
    true,
  )
  assert.equal(
    isAllowedRpcOrigin({ origin: "http://localhost:3000", referer: null, host: "localhost:3000" }),
    true,
  )
  assert.equal(
    isAllowedRpcOrigin({ origin: "https://evil.example", referer: null, host: "pnd.fyi" }),
    false,
  )
  // Lookalike suffix is not a match.
  assert.equal(
    isAllowedRpcOrigin({ origin: "https://pnd.fyi.evil.example", referer: null, host: "pnd.fyi" }),
    false,
  )
  // Configured extra origin (e.g. canonical host behind a preview).
  assert.equal(
    isAllowedRpcOrigin({
      origin: "https://pnd.fyi",
      referer: null,
      host: "deploy-preview-1--art-pin.netlify.app",
      allowedOrigins: ["https://pnd.fyi"],
    }),
    true,
  )
})

test("origin check falls back to referer and refuses requests naming neither", () => {
  assert.equal(
    isAllowedRpcOrigin({ origin: null, referer: "https://pnd.fyi/collections/0xabc", host: "pnd.fyi" }),
    true,
  )
  assert.equal(
    isAllowedRpcOrigin({ origin: null, referer: "https://evil.example/x", host: "pnd.fyi" }),
    false,
  )
  assert.equal(isAllowedRpcOrigin({ origin: null, referer: null, host: "pnd.fyi" }), false)
  assert.equal(isAllowedRpcOrigin({ origin: "null", referer: null, host: "pnd.fyi" }), false)
})

test("attempt timeout respects the overall deadline", () => {
  assert.equal(attemptTimeoutMs(6_000, 20_000, 0), 6_000)
  assert.equal(attemptTimeoutMs(6_000, 20_000, 17_000), 3_000)
  assert.equal(attemptTimeoutMs(6_000, 20_000, 19_900), 0)
})

test("batch responses merge per-entry errors with upstream results", () => {
  const err = rpcErrorResponse(7, -32601, "Method not allowed: x")
  const merged = mergeBatchResponses([err], JSON.stringify([{ jsonrpc: "2.0", id: 1, result: "0x1" }]))
  assert.deepEqual(merged, [err, { jsonrpc: "2.0", id: 1, result: "0x1" }])
  assert.equal(mergeBatchResponses([err], "{\"error\":\"nope\"}"), null)
  assert.equal(mergeBatchResponses([err], "not json"), null)
})
