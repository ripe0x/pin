import { describe, expect, it } from "vitest"
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  encodeFunctionData,
} from "viem"
import { sovereignAuctionHouseAbi, sovereignAuctionHouseV2Abi } from "./abi"
import {
  AUCTION_CHAIN_ID,
  buildBidRequest,
  buildSettleRequest,
  describeBidError,
} from "./bid-transaction"

const HOUSE = "0x1111111111111111111111111111111111111111" as const

describe("buildBidRequest", () => {
  it("builds a mainnet-pinned createBid on a V2 house", () => {
    const request = buildBidRequest({
      house: HOUSE,
      houseVersion: 2,
      auctionId: "7",
      value: 10n ** 17n,
    })
    expect(request).not.toBeNull()
    expect(request!.chainId).toBe(1)
    expect(request!.chainId).toBe(AUCTION_CHAIN_ID)
    expect(request!.address).toBe(HOUSE)
    expect(request!.abi).toBe(sovereignAuctionHouseV2Abi)
    expect(request!.functionName).toBe("createBid")
    expect(request!.args).toEqual([7n])
    expect(request!.value).toBe(10n ** 17n)
    const data = encodeFunctionData({
      abi: sovereignAuctionHouseV2Abi,
      functionName: "createBid",
      args: request!.args,
    })
    // createBid(uint256)
    expect(data.slice(0, 10)).toBe("0x659dd2b4")
  })

  it("refuses to build a bid on a V1 house", () => {
    expect(
      buildBidRequest({ house: HOUSE, houseVersion: 1, auctionId: "7", value: 1n }),
    ).toBeNull()
  })
})

describe("buildSettleRequest", () => {
  it("still settles V1 auctions, pinned to mainnet", () => {
    const request = buildSettleRequest({ house: HOUSE, houseVersion: 1, auctionId: 3n })
    expect(request.chainId).toBe(AUCTION_CHAIN_ID)
    expect(request.abi).toBe(sovereignAuctionHouseAbi)
    expect(request.functionName).toBe("endAuction")
    expect(request.args).toEqual([3n])
  })

  it("settles V2 auctions against the V2 ABI", () => {
    const request = buildSettleRequest({ house: HOUSE, houseVersion: 2, auctionId: "3" })
    expect(request.chainId).toBe(AUCTION_CHAIN_ID)
    expect(request.abi).toBe(sovereignAuctionHouseV2Abi)
    expect(request.functionName).toBe("endAuction")
  })
})

describe("describeBidError", () => {
  function reverted(errorName: string) {
    const abi = sovereignAuctionHouseV2Abi
    const data = encodeErrorResult({ abi, errorName } as Parameters<typeof encodeErrorResult>[0])
    const cause = new ContractFunctionRevertedError({ abi, data, functionName: "createBid" })
    return new BaseError("Execution reverted", { cause })
  }

  it("decodes house reverts from the cause chain", () => {
    expect(describeBidError(reverted("BidBelowMinimum"))).toMatch(/Refresh and raise/)
    expect(describeBidError(reverted("AuctionExpired"))).toBe("This auction has ended.")
  })

  it("names an unmapped revert", () => {
    expect(describeBidError(reverted("EscrowFailed"))).toBe(
      "The transaction reverted (EscrowFailed).",
    )
  })

  it("falls back to a short message", () => {
    expect(describeBidError(new Error("boom\nstack"))).toBe("boom")
  })
})
