/**
 * Run with:
 *   node --experimental-strip-types --test apps/web/src/lib/editions-rails.test.ts
 *
 * Pure-function tests for the Phase 2 permanence spend-rail helpers
 * (docs/editions-permanence-funding.md). These pin the honest-status decision:
 * durability is EARNED from which gateways actually resolved, never assumed.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  arweaveDurability,
  bareArweaveId,
  deriveArweaveUris,
  durabilityLabel,
} from "./editions-rails.ts"

const ID = "abc123DEF456-_xyz"

test("bareArweaveId strips ar://, arweave.net, and irys gateway prefixes", () => {
  assert.equal(bareArweaveId(ID), ID)
  assert.equal(bareArweaveId(`ar://${ID}`), ID)
  assert.equal(bareArweaveId(`AR://${ID}`), ID)
  assert.equal(bareArweaveId(`https://arweave.net/${ID}`), ID)
  assert.equal(bareArweaveId(`https://gateway.irys.xyz/${ID}`), ID)
  assert.equal(bareArweaveId(`  ar://${ID}  `), ID)
})

test("deriveArweaveUris returns ar:// + arweave.net + irys gateway, most-durable first", () => {
  const uris = deriveArweaveUris(`ar://${ID}`)
  assert.deepEqual(uris, [
    `ar://${ID}`,
    `https://arweave.net/${ID}`,
    `https://gateway.irys.xyz/${ID}`,
  ])
})

test("deriveArweaveUris returns [] for an empty id", () => {
  assert.deepEqual(deriveArweaveUris(""), [])
  assert.deepEqual(deriveArweaveUris("ar://"), [])
})

test("arweaveDurability: arweave.net resolving earns permanent-floor", () => {
  assert.equal(
    arweaveDurability({ arweaveResolved: true, irysResolved: true }),
    "permanent-floor",
  )
  // arweave.net is the proof; it wins even if the Irys gateway is down.
  assert.equal(
    arweaveDurability({ arweaveResolved: true, irysResolved: false }),
    "permanent-floor",
  )
})

test("arweaveDurability: only Irys resolving is irys-stored, not permanent", () => {
  assert.equal(
    arweaveDurability({ arweaveResolved: false, irysResolved: true }),
    "irys-stored",
  )
})

test("arweaveDurability: nothing resolving is unconfirmed", () => {
  assert.equal(
    arweaveDurability({ arweaveResolved: false, irysResolved: false }),
    "unconfirmed",
  )
})

test("durabilityLabel never calls a non-permanent state permanent", () => {
  assert.match(durabilityLabel("permanent-floor"), /permanent/i)
  assert.doesNotMatch(durabilityLabel("irys-stored"), /^permanent/i)
  assert.doesNotMatch(durabilityLabel("rented-hot"), /permanent/i)
  assert.doesNotMatch(durabilityLabel("unconfirmed"), /permanent/i)
})
