import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  buildFactoryAddressRows,
  missingAddresses,
  resolveFactoryId,
  type FactoryRow,
} from "./ponder-drift-check-lib.ts"

const FACTORIES: FactoryRow[] = [
  { id: 1, address: "0xae712abca452901a74d1fbc0c3919f2cc060ef9f", childAddressLocation: "topic2" },
  { id: 131, address: "0xdb81d3f33ef3d84685486916e0d372e247558094", childAddressLocation: "topic2" },
  { id: 134, address: "0xdb81d3f33ef3d84685486916e0d372e247558094", childAddressLocation: "offset0" },
  { id: 249, address: "0x77ab853543286c9cdd7dd6c01222a7cc4ac93d63", childAddressLocation: "topic2" },
]

test("resolveFactoryId matches on address alone, case-insensitively", () => {
  assert.equal(
    resolveFactoryId(FACTORIES, "0xAE712abcA452901A74D1FBC0c3919F2cc060EF9f"),
    1,
  )
})

test("resolveFactoryId disambiguates two watches on the same factory address by childAddressLocation", () => {
  assert.equal(resolveFactoryId(FACTORIES, "0xdb81d3f33ef3d84685486916e0d372e247558094", "topic2"), 131)
  assert.equal(resolveFactoryId(FACTORIES, "0xdb81d3f33ef3d84685486916e0d372e247558094", "offset0"), 134)
})

test("resolveFactoryId returns undefined for an address with no matching row", () => {
  assert.equal(resolveFactoryId(FACTORIES, "0x0000000000000000000000000000000000dead"), undefined)
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

test("buildFactoryAddressRows carries factory id, chain id, and block number through", () => {
  const rows = buildFactoryAddressRows(131, 1, [
    { address: "0xB741055bd0467a5831B8b5F7Df376cdA93A76af1", blockNumber: "25601000" },
  ])
  assert.deepEqual(rows, [
    { chain_id: 1, factory_id: 131, address: "0xb741055bd0467a5831b8b5f7df376cda93a76af1", block_number: "25601000" },
  ])
})
