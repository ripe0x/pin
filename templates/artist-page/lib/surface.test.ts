import { describe, expect, it } from "vitest"
import { isMintable, recentTokenIds } from "./surface"

describe("Surface collection helpers", () => {
  it("enforces mint windows and supply caps", () => {
    const open = { mintStart: 100n, mintEnd: 200n, supplyCap: 10n }
    expect(isMintable(open, 9n, 150)).toBe(true)
    expect(isMintable(open, 9n, 99)).toBe(false)
    expect(isMintable(open, 9n, 200)).toBe(false)
    expect(isMintable(open, 10n, 150)).toBe(false)
  })

  it("returns newest sequential token ids first", () => {
    expect(recentTokenIds(5n, 3)).toEqual([5n, 4n, 3n])
    expect(recentTokenIds(0n)).toEqual([])
  })
})
