import { describe, expect, it } from "vitest"
import {
  deserializeCollection,
  recentTokenIds,
  remainingSupply,
  resolveReferrer,
  salePhase,
  serializeCollection,
  ZERO_ADDRESS,
  type CollectionSummary,
} from "./surface"

const sale = {
  closed: false,
  mintStart: 100n,
  mintEnd: 200n,
  maxMints: 0n,
  totalMinted: 0n,
}

describe("Surface sale helpers", () => {
  it("follows the contracts' check order: closed, window, caps", () => {
    const c = { supplyCap: 10n, minted: 9n }
    expect(salePhase(c, sale, 150)).toBe("open")
    expect(salePhase(c, sale, 99)).toBe("not-started")
    // mintEnd is exclusive (block.timestamp >= mintEnd reverts MintEnded).
    expect(salePhase(c, sale, 200)).toBe("ended")
    expect(salePhase({ supplyCap: 10n, minted: 10n }, sale, 150)).toBe("sold-out")
    expect(salePhase(c, { ...sale, closed: true }, 150)).toBe("closed")
    expect(salePhase(c, { ...sale, mintStart: 0n, mintEnd: 0n }, 1)).toBe("open")
  })

  it("takes the tighter of supplyCap and the sale's maxMints", () => {
    expect(remainingSupply({ supplyCap: 0n, minted: 5n }, { maxMints: 0n, totalMinted: 0n })).toBe(null)
    expect(remainingSupply({ supplyCap: 10n, minted: 4n }, { maxMints: 0n, totalMinted: 0n })).toBe(6n)
    expect(remainingSupply({ supplyCap: 10n, minted: 4n }, { maxMints: 5n, totalMinted: 3n })).toBe(2n)
    expect(remainingSupply({ supplyCap: 0n, minted: 4n }, { maxMints: 3n, totalMinted: 3n })).toBe(0n)
    // An owner mint can push minted past what the sale saw; never negative.
    expect(remainingSupply({ supplyCap: 4n, minted: 5n }, null)).toBe(0n)
  })

  it("credits the site owner as referrer", () => {
    const owner = "0x1111111111111111111111111111111111111111" as const
    const artist = "0x2222222222222222222222222222222222222222" as const
    const configured = "0x3333333333333333333333333333333333333333" as const
    expect(resolveReferrer({ configured, owner, artist })).toBe(configured)
    expect(resolveReferrer({ configured: ZERO_ADDRESS, owner, artist })).toBe(ZERO_ADDRESS)
    expect(resolveReferrer({ configured: null, owner, artist })).toBe(owner)
    // Renounced (v2 permanence): no owner, fall back to the site's artist.
    expect(resolveReferrer({ configured: null, owner: ZERO_ADDRESS, artist })).toBe(artist)
  })

  it("round-trips a summary through the bigint-free form", () => {
    const c: CollectionSummary = {
      address: "0x1111111111111111111111111111111111111111",
      name: "N",
      symbol: "S",
      protocolVersion: 2,
      owner: "0x2222222222222222222222222222222222222222",
      supplyCap: 100n,
      minted: 3n,
      sequential: true,
      minter: "0x3333333333333333333333333333333333333333",
      sale: {
        kind: "v2-fixed-price",
        address: "0x3333333333333333333333333333333333333333",
        price: 10n ** 16n,
        quote1: 10n ** 16n,
        priceStrategy: null,
        mintStart: 0n,
        mintEnd: 0n,
        maxMints: 50n,
        totalMinted: 3n,
        walletCap: 2n,
        gated: false,
        closed: false,
        referralShareBps: 500,
        payoutRecipient: "0x2222222222222222222222222222222222222222",
      },
    }
    const s = serializeCollection(c)
    expect(() => JSON.stringify(s)).not.toThrow()
    expect(deserializeCollection(JSON.parse(JSON.stringify(s)))).toEqual(c)
  })

  it("returns newest sequential token ids first", () => {
    expect(recentTokenIds(5n, 3)).toEqual([5n, 4n, 3n])
    expect(recentTokenIds(0n)).toEqual([])
  })
})
