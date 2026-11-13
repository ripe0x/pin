/**
 * Run with: node --experimental-strip-types --test src/ownership.test.ts
 * (from apps/indexer). No ponder:registry/ponder:schema imports, so no live
 * indexer environment is needed.
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  ZERO_ADDRESS,
  classifyTransfer,
  ownerConfirmedAfterTransfer,
  surfaceOwnerAfterTransfer,
} from "./ownership.ts"

const OWNER = "0x365c000000000000000000000000000000005860"
const OTHER = "0xAbCd00000000000000000000000000000000Ef01"

test("renounce keeps a confirmed owner confirmed", () => {
  assert.equal(ownerConfirmedAfterTransfer(true, OWNER, ZERO_ADDRESS), true)
})

test("renounce keeps an unconfirmed owner unconfirmed (no new evidence either way)", () => {
  assert.equal(ownerConfirmedAfterTransfer(false, OWNER, ZERO_ADDRESS), false)
})

test("renounce with no prior value counts as confirmed: only the owner can renounce", () => {
  assert.equal(ownerConfirmedAfterTransfer(null, OWNER, ZERO_ADDRESS), true)
  assert.equal(ownerConfirmedAfterTransfer(undefined, OWNER, ZERO_ADDRESS), true)
})

test("a transfer the new owner sent itself is confirmed, case-insensitively", () => {
  assert.equal(ownerConfirmedAfterTransfer(false, OTHER.toLowerCase(), OTHER), true)
})

test("a transfer pushed by someone else is unconfirmed, whatever the prior value", () => {
  assert.equal(ownerConfirmedAfterTransfer(true, OWNER, OTHER), false)
  assert.equal(ownerConfirmedAfterTransfer(null, OWNER, OTHER), false)
})

test("classifyTransfer reads the zero-address legs", () => {
  assert.equal(classifyTransfer(ZERO_ADDRESS, OWNER), "mint")
  assert.equal(classifyTransfer(OWNER, ZERO_ADDRESS), "burn")
  assert.equal(classifyTransfer(OWNER, OTHER), "transfer")
})

test("Surface mint transfers are left to the Minted handler", () => {
  assert.equal(surfaceOwnerAfterTransfer(ZERO_ADDRESS, OWNER), null)
})

test("Surface burn sets the owner to the zero address", () => {
  assert.equal(surfaceOwnerAfterTransfer(OWNER, ZERO_ADDRESS), ZERO_ADDRESS)
})

test("Surface transfer moves the owner to the recipient", () => {
  assert.equal(surfaceOwnerAfterTransfer(OWNER, OTHER), OTHER)
})
