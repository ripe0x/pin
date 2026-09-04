import assert from "node:assert/strict"
import test from "node:test"
import { decodeProfileCursor, encodeProfileCursor } from "./profile-cursor"

const ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

test("profile cursor round-trips a deterministic keyset position", () => {
  const cursor = {
    block: "25900000",
    logIndex: "7",
    contract: ADDRESS,
    tokenId: "42",
  }
  assert.deepEqual(decodeProfileCursor(encodeProfileCursor(cursor)), cursor)
})

test("profile cursor rejects malformed and non-address input", () => {
  assert.equal(decodeProfileCursor("not-base64-json"), null)
  const invalid = Buffer.from(JSON.stringify({
    block: "1",
    logIndex: "2",
    contract: "0xabc",
    tokenId: "3",
  })).toString("base64url")
  assert.equal(decodeProfileCursor(invalid), null)
})
