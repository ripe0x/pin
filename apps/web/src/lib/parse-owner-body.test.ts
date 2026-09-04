import { strict as assert } from "node:assert"
import { test } from "node:test"
import { parseOwnerBody } from "./parse-owner-body.ts"

const VALID_LOWERCASE = "0xc409de9b341dbac065359cf053c3572e4976531b"
const VALID_CHECKSUMMED = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"

test("accepts an all-lowercase address", () => {
  const r = parseOwnerBody({ owner: VALID_LOWERCASE })
  assert.ok(!("error" in r))
  assert.equal((r as { owner: string }).owner, VALID_LOWERCASE)
})

test("accepts a correctly checksummed address", () => {
  const r = parseOwnerBody({ owner: VALID_CHECKSUMMED })
  assert.ok(!("error" in r))
  assert.equal((r as { owner: string }).owner, VALID_CHECKSUMMED)
})

test("rejects a mixed-case address with a bad checksum", () => {
  const r = parseOwnerBody({ owner: "0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" })
  assert.ok("error" in r)
})

test("rejects a missing owner field", () => {
  const r = parseOwnerBody({})
  assert.ok("error" in r)
})

test("rejects a null body", () => {
  const r = parseOwnerBody(null)
  assert.ok("error" in r)
})

test("rejects a non-string owner", () => {
  const r = parseOwnerBody({ owner: 12345 })
  assert.ok("error" in r)
})

test("rejects a malformed address (bad length)", () => {
  const r = parseOwnerBody({ owner: "0xC409de9B341Dbac065359CF053C3572E4976" })
  assert.ok("error" in r)
})

test("rejects a string missing the 0x prefix", () => {
  const r = parseOwnerBody({ owner: VALID_LOWERCASE.slice(2) })
  assert.ok("error" in r)
})
