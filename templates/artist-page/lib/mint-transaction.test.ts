import { describe, expect, it } from "vitest"
import { buildMintWithRewardsRequest } from "./mint-transaction"

describe("Surface mint transaction", () => {
  it("sends the live quoted price with the payable mint", () => {
    const request = buildMintWithRewardsRequest({
      collectionAddress: "0x1111111111111111111111111111111111111111",
      artistAddress: "0x2222222222222222222222222222222222222222",
      priceWei: 42n,
    })
    expect(request.functionName).toBe("mintWithRewards")
    expect(request.args).toEqual([
      1n,
      "0x2222222222222222222222222222222222222222",
      "0x",
    ])
    expect(request.value).toBe(42n)
  })
})
