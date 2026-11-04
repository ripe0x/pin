import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  auctionHouseStreams,
  buildFactoryAddressRows,
  factoryCandidates,
  missingAddresses,
  repairEnabled,
  resolveFactoryStream,
  type FactoryRow,
  type FactoryStream,
} from "./ponder-drift-check-lib.ts"

const SURFACE = "0xdb81d3f33ef3d84685486916e0d372e247558094"
const SURFACE_CREATED = "0x1111111111111111111111111111111111111111111111111111111111111111"
const OLD_SURFACE_CREATED = "0x2222222222222222222222222222222222222222222222222222222222222222"
const HOUSE_CREATED = "0x3333333333333333333333333333333333333333333333333333333333333333"

const FACTORIES: FactoryRow[] = [
  { id: 1, address: "0xae712abca452901a74d1fbc0c3919f2cc060ef9f", childAddressLocation: "topic2", eventSelector: HOUSE_CREATED, chainId: 1 },
  // A stale build that bound the pre-name/symbol SurfaceCreated signature.
  { id: 90, address: SURFACE, childAddressLocation: "topic2", eventSelector: OLD_SURFACE_CREATED, chainId: 1 },
  { id: 131, address: SURFACE, childAddressLocation: "topic2", eventSelector: SURFACE_CREATED, chainId: 1 },
  { id: 134, address: SURFACE, childAddressLocation: "offset0", eventSelector: SURFACE_CREATED, chainId: 1 },
  // Same stream on another chain.
  { id: 200, address: SURFACE, childAddressLocation: "topic2", eventSelector: SURFACE_CREATED, chainId: 11155111 },
]

const surfaceCollections: FactoryStream = {
  address: "0xdB81d3F33EF3D84685486916E0d372E247558094",
  childAddressLocation: "topic2",
  eventSelector: SURFACE_CREATED,
  chainId: 1,
}

test("factoryCandidates matches address case-insensitively and filters event, location and chain", () => {
  assert.deepEqual(factoryCandidates(FACTORIES, surfaceCollections).map((f) => f.id), [131])
  assert.deepEqual(
    factoryCandidates(FACTORIES, { ...surfaceCollections, childAddressLocation: "offset0" }).map((f) => f.id),
    [134],
  )
})

test("factoryCandidates never matches a build that bound a different factory event", () => {
  assert.deepEqual(
    factoryCandidates(FACTORIES, { ...surfaceCollections, eventSelector: OLD_SURFACE_CREATED }).map((f) => f.id),
    [90],
  )
  assert.deepEqual(factoryCandidates(FACTORIES, { ...surfaceCollections, eventSelector: HOUSE_CREATED }), [])
})

test("resolveFactoryStream: no candidates, one candidate", () => {
  assert.deepEqual(resolveFactoryStream([], new Map()), { kind: "none" })
  assert.deepEqual(resolveFactoryStream([FACTORIES[2]!], new Map()), { kind: "resolved", id: 131 })
})

test("resolveFactoryStream picks the candidate covering the schema's rows best, regardless of id order", () => {
  const a = { ...FACTORIES[2]!, id: 131, fromBlock: 25_590_436 }
  const b = { ...FACTORIES[2]!, id: 300, fromBlock: 25_600_000 }
  assert.deepEqual(resolveFactoryStream([a, b], new Map([[131, 3], [300, 12]])), { kind: "resolved", id: 300 })
  assert.deepEqual(resolveFactoryStream([b, a], new Map([[131, 12], [300, 3]])), { kind: "resolved", id: 131 })
})

test("resolveFactoryStream reports a tie as ambiguous instead of guessing", () => {
  const a = { ...FACTORIES[2]!, id: 131 }
  const b = { ...FACTORIES[2]!, id: 300 }
  assert.deepEqual(resolveFactoryStream([a, b], new Map([[131, 5], [300, 5]])), { kind: "ambiguous", ids: [131, 300] })
})

test("repair is opt-in", () => {
  assert.equal(repairEnabled(undefined), false)
  assert.equal(repairEnabled(""), false)
  assert.equal(repairEnabled("0"), false)
  assert.equal(repairEnabled("1"), true)
  assert.equal(repairEnabled("TRUE"), true)
})

test("missingAddresses returns source addresses absent from existing, lowercased and deduped", () => {
  const source = ["0xAAA0000000000000000000000000000000aaaa", "0xbbb0000000000000000000000000000000bbbb", "0xaaa0000000000000000000000000000000aaaa"]
  const existing = ["0xbbb0000000000000000000000000000000bbbb"]
  assert.deepEqual(missingAddresses(source, existing), ["0xaaa0000000000000000000000000000000aaaa"])
})

test("missingAddresses returns empty when every source address already exists", () => {
  const source = ["0xaaa0000000000000000000000000000000aaaa"]
  const existing = ["0xAAA0000000000000000000000000000000AAAA"]
  assert.deepEqual(missingAddresses(source, existing), [])
})

test("auctionHouseStreams omits the V2.1 stream until its factory is configured", () => {
  const streams = auctionHouseStreams({ v1: "0xv1", v2: "0xv2", v2_1: null })
  assert.deepEqual(
    streams.map((s) => [s.label, s.version, s.factory]),
    [
      ["PND V1 houses", 1, "0xv1"],
      ["PND V2 houses", 2, "0xv2"],
    ],
  )
})

test("auctionHouseStreams checks V2.1 houses (version 21) against the V2.1 factory once set", () => {
  const streams = auctionHouseStreams({ v1: "0xv1", v2: "0xv2", v2_1: "0xv21" })
  assert.deepEqual(streams.at(-1), { label: "PND V2.1 houses", version: 21, factory: "0xv21" })
  assert.equal(streams.length, 3)
})

test("buildFactoryAddressRows carries factory id, chain id, and block number through", () => {
  const rows = buildFactoryAddressRows(131, 1, [
    { address: "0xB741055bd0467a5831B8b5F7Df376cdA93A76af1", blockNumber: "25601000" },
  ])
  assert.deepEqual(rows, [
    { chain_id: 1, factory_id: 131, address: "0xb741055bd0467a5831b8b5f7df376cda93a76af1", block_number: "25601000" },
  ])
})
