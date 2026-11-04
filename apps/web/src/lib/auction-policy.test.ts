import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  ERC1155_HELD_FOR_WINNER_NOTE,
  ERC1155_SETTLEMENT_NOTE,
  HELD_FOR_WINNER,
  PND_SOLD_STATUSES_SQL,
  canBid,
  canListStandard,
  claimRecipientError,
  classifyAccountCode,
  houseFromIndexerVersion,
  listingBlockReason,
  needsHeldForWinnerRead,
  resolveHeldForWinner,
  settlementNoteFor,
  showsHeldForWinnerNote,
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

// ── V2.1 ────────────────────────────────────────────────────────────────

test("houseFromIndexerVersion: 21 is a V2-compatible V2.1 house; 2 and 1 unchanged", () => {
  assert.deepEqual(houseFromIndexerVersion(21), { houseVersion: 2, houseIsV2_1: true })
  assert.deepEqual(houseFromIndexerVersion(2), { houseVersion: 2, houseIsV2_1: false })
  assert.deepEqual(houseFromIndexerVersion(1), { houseVersion: 1, houseIsV2_1: false })
})

test("houseFromIndexerVersion: missing or unknown versions fold to V1 (offers the least)", () => {
  for (const v of [undefined, null, 0, 3, 22, Number.NaN]) {
    assert.deepEqual(houseFromIndexerVersion(v), { houseVersion: 1, houseIsV2_1: false }, String(v))
  }
})

test("canBid: V2.1 listings are biddable", () => {
  assert.equal(canBid({ source: "sovereign", houseVersion: 2, houseIsV2_1: true }), true)
})

test("listingBlockReason: ERC-1155 is allowed on V2.1 houses and still paused on V2", () => {
  assert.equal(listingBlockReason(2, "erc1155", true), null)
  assert.equal(listingBlockReason(2, "erc721", true), null)
  assert.equal(listingBlockReason(2, "erc1155", false), "erc1155-paused")
  assert.equal(listingBlockReason(2, "erc1155"), "erc1155-paused")
  assert.equal(canListStandard(2, "erc1155", true), true)
})

test("listingBlockReason: the V2.1 flag never unblocks a V1 house", () => {
  assert.equal(listingBlockReason(1, "erc1155", true), "v1-house")
  assert.equal(listingBlockReason(1, "erc721", true), "v1-house")
})

test("settlement notes: delay note on V2 1155 only, held-for-winner note on V2.1 1155 only", () => {
  const v2_1155 = { source: "sovereign" as const, houseVersion: 2 as const, tokenStandard: "erc1155" as const }
  const v21_1155 = { ...v2_1155, houseIsV2_1: true }
  const v21_721 = { ...v21_1155, tokenStandard: "erc721" as const }

  assert.equal(showsSettlementDelayNote(v2_1155), true)
  assert.equal(showsSettlementDelayNote(v21_1155), false)
  assert.equal(showsHeldForWinnerNote(v21_1155), true)
  assert.equal(showsHeldForWinnerNote(v2_1155), false)
  assert.equal(showsHeldForWinnerNote(v21_721), false)

  assert.equal(settlementNoteFor(v2_1155), ERC1155_SETTLEMENT_NOTE)
  assert.equal(settlementNoteFor(v21_1155), ERC1155_HELD_FOR_WINNER_NOTE)
  assert.equal(settlementNoteFor(v21_721), null)
  assert.equal(settlementNoteFor({ source: "foundation", houseVersion: 1, tokenStandard: "erc1155" }), null)
  assert.match(ERC1155_HELD_FOR_WINNER_NOTE, /seller is paid/)
  assert.match(ERC1155_HELD_FOR_WINNER_NOTE, /any address/)
})

test("resolveHeldForWinner: the indexer's held_for_winner status is used as-is", () => {
  assert.equal(
    resolveHeldForWinner({ status: "held_for_winner", houseIsV2_1: true, claimRecipient: null, heldOnchain: null }),
    "held_for_winner",
  )
})

test("resolveHeldForWinner: a V2.1 'settled' row with no claim falls back to the onchain read", () => {
  const row = { status: "settled", houseIsV2_1: true, claimRecipient: null }
  assert.equal(needsHeldForWinnerRead(row), true)
  assert.equal(resolveHeldForWinner({ ...row, heldOnchain: true }), "held_for_winner")
  assert.equal(resolveHeldForWinner({ ...row, heldOnchain: false }), "settled")
  // A failed read keeps the indexer's status.
  assert.equal(resolveHeldForWinner({ ...row, heldOnchain: null }), "settled")
})

test("resolveHeldForWinner: no onchain read for V2 houses, claimed lots or other statuses", () => {
  assert.equal(needsHeldForWinnerRead({ status: "settled", houseIsV2_1: false, claimRecipient: null }), false)
  assert.equal(
    needsHeldForWinnerRead({ status: "settled", houseIsV2_1: true, claimRecipient: "0x" + "11".repeat(20) }),
    false,
  )
  for (const status of ["active", "deferred", "cancelled", "unwound", "unwound_return_pending"]) {
    assert.equal(needsHeldForWinnerRead({ status, houseIsV2_1: true, claimRecipient: null }), false, status)
  }
  // Even a stray true never relabels a V2 row or a claimed lot.
  assert.equal(
    resolveHeldForWinner({ status: "settled", houseIsV2_1: false, claimRecipient: null, heldOnchain: true }),
    "settled",
  )
  assert.equal(
    resolveHeldForWinner({
      status: "settled",
      houseIsV2_1: true,
      claimRecipient: "0x" + "11".repeat(20),
      heldOnchain: true,
    }),
    "settled",
  )
})

test("PND_SOLD_STATUSES_SQL counts held-for-winner lots as sales", () => {
  assert.equal(PND_SOLD_STATUSES_SQL, "('settled', 'held_for_winner')")
  assert.equal(HELD_FOR_WINNER, "held_for_winner")
})

test("claimRecipientError: rejects malformed, zero and house-self recipients", () => {
  const house = "0x" + "ab".repeat(20)
  assert.equal(claimRecipientError("0x" + "12".repeat(20), house), null)
  assert.match(claimRecipientError("0x1234", house) ?? "", /full 0x address/)
  assert.match(claimRecipientError("0x" + "00".repeat(20), house) ?? "", /zero address/)
  assert.match(claimRecipientError(house.toUpperCase().replace("0X", "0x"), house) ?? "", /house itself/)
})
