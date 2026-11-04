import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  TimeoutError,
} from "viem"
import { classifyReadError, settleRead } from "./read-errors.ts"

const abi = [{
  type: "function", name: "supportsInterface", stateMutability: "view",
  inputs: [{ name: "id", type: "bytes4" }], outputs: [{ type: "bool" }],
}] as const

test("a revert or empty return is a real negative, even when wrapped", () => {
  const reverted = new ContractFunctionRevertedError({ abi, functionName: "supportsInterface" })
  assert.equal(classifyReadError(reverted), "negative")
  assert.equal(classifyReadError(new BaseError("call failed", { cause: reverted })), "negative")
  assert.equal(
    classifyReadError(new ContractFunctionZeroDataError({ functionName: "supportsInterface" })),
    "negative",
  )
})

test("transport failures are transient", () => {
  assert.equal(classifyReadError(new HttpRequestError({ url: "https://rpc", status: 503 })), "transient")
  assert.equal(classifyReadError(new TimeoutError({ body: {}, url: "https://rpc" })), "transient")
  assert.equal(
    classifyReadError(new BaseError("call failed", { cause: new HttpRequestError({ url: "x", status: 429 }) })),
    "transient",
  )
  assert.equal(classifyReadError(new Error("socket hang up")), "transient")
})

test("settleRead maps negatives to the default and reports transients", async () => {
  assert.deepEqual(await settleRead(Promise.resolve(true), false), { ok: true, value: true })
  assert.deepEqual(
    await settleRead(Promise.reject(new ContractFunctionRevertedError({ abi, functionName: "supportsInterface" })), false),
    { ok: true, value: false },
  )
  const r = await settleRead(Promise.reject(new TimeoutError({ body: {}, url: "x" })), false)
  assert.equal(r.ok, false)
})
