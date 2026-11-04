import { strict as assert } from "node:assert"
import { afterEach, test } from "node:test"
import { NOT_SURFACE_BODY, isNotSurfaceResponse } from "./not-surface.ts"
import { fetchGateState } from "../components/studio/mint-gate/gate-api.ts"
import { fetchSaleState } from "../components/studio/sale/sale-api.ts"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch
}

const ADDR = "0x00000000000000000000000000000000000000aa"

test("isNotSurfaceResponse: only a 404 carrying notSurface: true", () => {
  assert.equal(isNotSurfaceResponse(404, NOT_SURFACE_BODY), true)
  assert.equal(isNotSurfaceResponse(404, { error: "Not found" }), false)
  assert.equal(isNotSurfaceResponse(200, NOT_SURFACE_BODY), false)
  assert.equal(isNotSurfaceResponse(404, null), false)
  assert.equal(isNotSurfaceResponse(404, "notSurface"), false)
})

test("fetchGateState: a non-Surface address resolves to 'not-surface'", async () => {
  stubFetch(404, NOT_SURFACE_BODY)
  assert.equal(await fetchGateState(ADDR), "not-surface")
})

test("fetchGateState: other failures stay null, a summary passes through", async () => {
  stubFetch(500, { error: "boom" })
  assert.equal(await fetchGateState(ADDR), null)
  const summary = { gated: false, minter: null, knownMinter: false, cap: "0" }
  stubFetch(200, summary)
  assert.deepEqual(await fetchGateState(ADDR), summary)
})

test("fetchSaleState: a non-Surface address resolves to 'not-surface'", async () => {
  stubFetch(404, NOT_SURFACE_BODY)
  assert.equal(await fetchSaleState(ADDR), "not-surface")
})

test("fetchSaleState: other failures stay null", async () => {
  stubFetch(502, { error: "Could not read this collection." })
  assert.equal(await fetchSaleState(ADDR), null)
})
