import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  canBid,
  canListStandard,
  classifyAccountCode,
  listingBlockReason,
  showsSettlementDelayNote,
  winnerCodeNote,
} from "./auction-policy.ts"

test("canBid: sovereign V1 listings are not biddable on PND", () => {
  assert.equal(canBid({ source: "sovereign", houseVersion: 1 }), false)
})

test("canBid: sovereign V2 listings are biddable", () => {
  assert.equal(canBid({ source: "sovereign", houseVersion: 2 }), true)
})

test("canBid: non-sovereign sources ignore the placeholder houseVersion 1", () => {
  for (const source of ["foundation", "superrareV2", "transient"] as const) {
    assert.equal(canBid({ source, houseVersion: 1 }), true, source)
  }
})

test("listingBlockReason: V1 houses block every standard", () => {
  assert.equal(listingBlockReason(1, "erc721"), "v1-house")
  assert.equal(listingBlockReason(1, "erc1155"), "v1-house")
})

test("listingBlockReason: V2 ERC-721 is allowed, V2 ERC-1155 is paused", () => {
  assert.equal(listingBlockReason(2, "erc721"), null)
  assert.equal(listingBlockReason(2, "erc1155"), "erc1155-paused")
})

test("canListStandard mirrors listingBlockReason", () => {
  assert.equal(canListStandard(2, "erc721"), true)
  assert.equal(canListStandard(2, "erc1155"), false)
  assert.equal(canListStandard(1, "erc721"), false)
  assert.equal(canListStandard(1, "erc1155"), false)
})

test("showsSettlementDelayNote only for sovereign V2 ERC-1155 lots", () => {
  assert.equal(
    showsSettlementDelayNote({ source: "sovereign", houseVersion: 2, tokenStandard: "erc1155" }),
    true,
  )
  assert.equal(
    showsSettlementDelayNote({ source: "sovereign", houseVersion: 2, tokenStandard: "erc721" }),
    false,
  )
  assert.equal(
    showsSettlementDelayNote({ source: "foundation", houseVersion: 1, tokenStandard: "erc1155" }),
    false,
  )
})

test("classifyAccountCode: empty code is a plain account", () => {
  assert.equal(classifyAccountCode(undefined), "eoa")
  assert.equal(classifyAccountCode(null), "eoa")
  assert.equal(classifyAccountCode("0x"), "eoa")
})

test("classifyAccountCode: EIP-7702 designator is a delegated account", () => {
  const designator = "0xef0100" + "ab".repeat(20)
  assert.equal(classifyAccountCode(designator), "delegated")
  assert.equal(classifyAccountCode("0xEF0100" + "AB".repeat(20)), "delegated")
})

test("classifyAccountCode: other bytecode is a contract", () => {
  assert.equal(classifyAccountCode("0x6080604052"), "contract")
  // An ef0100 prefix with the wrong length is not a valid designator.
  assert.equal(classifyAccountCode("0xef0100abcd"), "contract")
})

test("winnerCodeNote copy", () => {
  assert.equal(winnerCodeNote("eoa"), null)
  assert.equal(winnerCodeNote(null), null)
  assert.match(winnerCodeNote("contract") ?? "", /contract account/)
  assert.match(winnerCodeNote("delegated") ?? "", /EIP-7702/)
})
