import { describe, expect, it, vi } from "vitest"
import {
  auctionRouteId,
  classifyV2LiveAuction,
  decodeV2HouseLogs,
  fetchV2HouseEventData,
  mergeArtistHouses,
  parseAuctionRouteId,
} from "./auction-status"

const V1_HOUSE = "0x1111111111111111111111111111111111111111"
const V2_HOUSE = "0x2222222222222222222222222222222222222222"

describe("mergeArtistHouses", () => {
  it("returns no houses when neither factory has one", () => {
    expect(mergeArtistHouses(null, null)).toEqual({ v1: null, v2: null, all: [] })
  })

  it("resolves a V1-only artist", () => {
    const result = mergeArtistHouses(V1_HOUSE, null)
    expect(result).toEqual({
      v1: V1_HOUSE,
      v2: null,
      all: [{ address: V1_HOUSE, version: 1 }],
    })
  })

  it("resolves a V2-only artist", () => {
    const result = mergeArtistHouses(null, V2_HOUSE)
    expect(result).toEqual({
      v1: null,
      v2: V2_HOUSE,
      all: [{ address: V2_HOUSE, version: 2 }],
    })
  })

  it("lists V2 before V1 for a migrated artist holding both", () => {
    const result = mergeArtistHouses(V1_HOUSE, V2_HOUSE)
    expect(result).toEqual({
      v1: V1_HOUSE,
      v2: V2_HOUSE,
      all: [
        { address: V2_HOUSE, version: 2 },
        { address: V1_HOUSE, version: 1 },
      ],
    })
  })
})

describe("auction route ids", () => {
  it("keeps V1 auctions on a bare numeric id (existing shared links)", () => {
    expect(auctionRouteId({ auctionId: "3", houseVersion: 1 })).toBe("3")
    expect(parseAuctionRouteId("3")).toEqual({ houseVersion: 1, auctionId: "3" })
  })

  it("prefixes V2 auctions so a colliding numeric id disambiguates", () => {
    expect(auctionRouteId({ auctionId: "3", houseVersion: 2 })).toBe("v2-3")
    expect(parseAuctionRouteId("v2-3")).toEqual({ houseVersion: 2, auctionId: "3" })
  })

  it("rejects malformed ids", () => {
    expect(parseAuctionRouteId("abc")).toBeNull()
    expect(parseAuctionRouteId("v2-")).toBeNull()
    expect(parseAuctionRouteId("v2-abc")).toBeNull()
  })
})

describe("classifyV2LiveAuction", () => {
  it("reports upcoming before any bid", () => {
    expect(
      classifyV2LiveAuction(0n, { pendingDelivery: false, pendingReturn: false }),
    ).toEqual({ status: "upcoming" })
  })

  it("reports live once a bid has landed", () => {
    expect(
      classifyV2LiveAuction(1_700_000_000n, { pendingDelivery: false, pendingReturn: false }),
    ).toEqual({ status: "live" })
  })

  it("reports deferred when settlement delivery failed", () => {
    expect(
      classifyV2LiveAuction(1_700_000_000n, { pendingDelivery: true, pendingReturn: false }),
    ).toEqual({ status: "deferred" })
  })

  it("reports unwound_return_pending, and prefers it over pendingDelivery", () => {
    expect(
      classifyV2LiveAuction(1_700_000_000n, { pendingDelivery: false, pendingReturn: true }),
    ).toEqual({ status: "unwound_return_pending" })
    // The contract clears pendingDelivery in the same call that may set
    // pendingReturn, so this combination shouldn't occur onchain, but if it
    // ever did, the unwind outcome (irreversible) must win over the retry.
    expect(
      classifyV2LiveAuction(1_700_000_000n, { pendingDelivery: true, pendingReturn: true }),
    ).toEqual({ status: "unwound_return_pending" })
  })
})

describe("decodeV2HouseLogs", () => {
  it("buckets an ERC721 listing, its settlement, a cancellation, and an unwind by auction id", () => {
    const data = decodeV2HouseLogs([
      {
        eventName: "AuctionCreated",
        args: {
          auctionId: 0n,
          tokenId: 5n,
          tokenContract: "0xaaaa000000000000000000000000000000000a",
          duration: 86_400n,
          reservePrice: 1_000_000_000_000_000_000n,
          tokenOwner: "0xbbbb000000000000000000000000000000000b",
          fundsRecipient: "0xcccc000000000000000000000000000000000c",
          listingExpiry: 1_800_000_000n,
        },
      },
      {
        eventName: "AuctionEnded",
        args: {
          auctionId: 0n,
          tokenOwner: "0xbbbb000000000000000000000000000000000b",
          winner: "0xdddd000000000000000000000000000000000d",
          sellerProceeds: 950_000_000_000_000_000n,
          protocolFee: 50_000_000_000_000_000n,
        },
      },
      {
        eventName: "AuctionCanceled",
        args: { auctionId: 1n },
      },
      {
        eventName: "LotUnwound",
        args: {
          auctionId: 2n,
          winner: "0xeeee000000000000000000000000000000000e",
          refundAmount: 2_000_000_000_000_000_000n,
          tokenOwner: "0xbbbb000000000000000000000000000000000b",
        },
      },
    ])

    expect(data.created["0"]).toMatchObject({
      standard: "erc721",
      quantity: "1",
      tokenId: "5",
      listingExpiry: "1800000000",
    })
    expect(data.settled["0"]).toEqual({
      winner: "0xdddd000000000000000000000000000000000d",
      sellerProceeds: "950000000000000000",
      protocolFee: "50000000000000000",
    })
    expect(data.cancelled).toEqual(["1"])
    expect(data.unwound["2"]).toEqual({
      winner: "0xeeee000000000000000000000000000000000e",
      refundAmount: "2000000000000000000",
      tokenOwner: "0xbbbb000000000000000000000000000000000b",
    })
  })

  it("marks an Auction1155Created listing as erc1155 with its quantity", () => {
    const data = decodeV2HouseLogs([
      {
        eventName: "Auction1155Created",
        args: {
          auctionId: 4n,
          tokenId: 7n,
          tokenContract: "0xaaaa000000000000000000000000000000000a",
          quantity: 25n,
          duration: 3_600n,
          reservePrice: 0n,
          tokenOwner: "0xbbbb000000000000000000000000000000000b",
          fundsRecipient: "0xbbbb000000000000000000000000000000000b",
          listingExpiry: 0n,
        },
      },
    ])
    expect(data.created["4"]).toMatchObject({ standard: "erc1155", quantity: "25" })
  })

  it("defaults missing args to the zero address instead of throwing", () => {
    const data = decodeV2HouseLogs([{ eventName: "AuctionCanceled", args: {} }])
    expect(data.cancelled).toEqual([])
    expect(data).toEqual({ created: {}, settled: {}, cancelled: [], unwound: {} })
  })
})

vi.mock("./rpc", () => ({
  getLogsChunked: vi.fn(),
}))

describe("fetchV2HouseEventData (chain client mocked)", () => {
  it("scans the house for every V2 lifecycle event and decodes the result", async () => {
    const { getLogsChunked } = await import("./rpc")
    const mockLogs = [
      {
        eventName: "AuctionCreated",
        args: {
          auctionId: 0n,
          tokenId: 1n,
          tokenContract: "0xaaaa000000000000000000000000000000000a",
          duration: 60n,
          reservePrice: 1n,
          tokenOwner: "0xbbbb000000000000000000000000000000000b",
          fundsRecipient: "0xbbbb000000000000000000000000000000000b",
          listingExpiry: 0n,
        },
      },
    ]
    vi.mocked(getLogsChunked).mockResolvedValue(mockLogs as never)

    const result = await fetchV2HouseEventData(V2_HOUSE, 100n, 200n)

    expect(getLogsChunked).toHaveBeenCalledTimes(1)
    const call = vi.mocked(getLogsChunked).mock.calls[0][0]
    expect(call.address).toBe(V2_HOUSE)
    expect(call.fromBlock).toBe(100n)
    expect(call.toBlock).toBe(200n)
    expect("events" in call ? call.events.length : 0).toBe(5)

    expect(result.created["0"]).toMatchObject({ tokenId: "1", standard: "erc721" })
  })
})
