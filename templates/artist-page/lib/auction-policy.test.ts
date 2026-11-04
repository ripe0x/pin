import { describe, expect, it } from "vitest"
import {
  ERC1155_SETTLEMENT_NOTE,
  V1_BIDS_PAUSED_NOTICE,
  canBid,
  showsSettlementDelayNote,
} from "./auction-policy"

describe("canBid", () => {
  it("pauses bids on V1 houses", () => {
    expect(canBid(1)).toBe(false)
  })

  it("offers bids on V2 houses", () => {
    expect(canBid(2)).toBe(true)
  })
})

describe("showsSettlementDelayNote", () => {
  it("flags only V2 ERC-1155 lots", () => {
    expect(showsSettlementDelayNote({ houseVersion: 2, standard: "erc1155" })).toBe(true)
    expect(showsSettlementDelayNote({ houseVersion: 2, standard: "erc721" })).toBe(false)
    expect(showsSettlementDelayNote({ houseVersion: 1, standard: "erc721" })).toBe(false)
  })
})

describe("notices", () => {
  it("speaks to the artist's own site, not to PND sellers", () => {
    expect(V1_BIDS_PAUSED_NOTICE).toMatch(/paused/)
    expect(V1_BIDS_PAUSED_NOTICE).toMatch(/the artist/)
    expect(V1_BIDS_PAUSED_NOTICE).not.toMatch(/sellers/)
    expect(ERC1155_SETTLEMENT_NOTE).toMatch(/30 days/)
  })
})
