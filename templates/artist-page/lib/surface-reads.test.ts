import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import { readCollectionSummary, type ReadClient } from "./surface-reads"
import { V2_IMINTER_INTERFACE_ID } from "./surface"

const TOKEN = "0x1111111111111111111111111111111111111111" as Address
const SALE = "0x5555555555555555555555555555555555555555" as Address
const OWNER = "0x2222222222222222222222222222222222222222" as Address
const ZERO = "0x0000000000000000000000000000000000000000" as Address

type Call = { address: Address; functionName: string; args?: readonly unknown[] }
type Table = Record<string, unknown>

/** A multicall stub answering from `${address}:${functionName}` keys; any
 *  missing key reads as a revert, like an absent function on chain. */
function stubClient(table: Table): ReadClient {
  return {
    multicall: (async ({ contracts }: { contracts: Call[] }) =>
      contracts.map((c) => {
        const key = `${c.address}:${c.functionName}`
        if (c.functionName === "supportsInterface") {
          const hit = table[key] as string | undefined
          return { status: "success", result: hit === c.args?.[0] }
        }
        return key in table
          ? { status: "success", result: table[key] }
          : { status: "failure", error: new Error("reverted") }
      })) as unknown as ReadClient["multicall"],
    readContract: (async () => {
      throw new Error("not stubbed")
    }) as unknown as ReadClient["readContract"],
  }
}

const v2Token: Table = {
  [`${TOKEN}:name`]: "Work",
  [`${TOKEN}:symbol`]: "WRK",
  [`${TOKEN}:version`]: 2n,
  [`${TOKEN}:owner`]: OWNER,
  [`${TOKEN}:minter`]: SALE,
  [`${TOKEN}:config`]: [ZERO, SALE, 100n, 500, OWNER, 7n],
}
const v2Sale: Table = {
  [`${SALE}:version`]: 2n,
  [`${SALE}:supportsInterface`]: V2_IMINTER_INTERFACE_ID,
  [`${SALE}:collection`]: TOKEN,
  [`${SALE}:price`]: 10n ** 16n,
  [`${SALE}:mintStart`]: 0n,
  [`${SALE}:mintEnd`]: 0n,
  [`${SALE}:maxMints`]: 0n,
  [`${SALE}:walletCap`]: 2n,
  [`${SALE}:gate`]: ZERO,
  [`${SALE}:closed`]: false,
  [`${SALE}:totalMinted`]: 7n,
  [`${SALE}:payoutRecipient`]: OWNER,
}

describe("readCollectionSummary", () => {
  it("detects a v2 token driven by a canonical FixedPriceSale", async () => {
    const c = await readCollectionSummary(stubClient({ ...v2Token, ...v2Sale }), TOKEN)
    expect(c?.protocolVersion).toBe(2)
    expect(c?.supplyCap).toBe(100n)
    expect(c?.minted).toBe(7n)
    expect(c?.sale?.kind).toBe("v2-fixed-price")
    expect(c?.sale?.referralShareBps).toBe(500)
    expect(c?.sale?.gated).toBe(false)
  })

  it("refuses a v2 minter that is not a FixedPriceSale for this token", async () => {
    const bespoke = { ...v2Token, ...v2Sale, [`${SALE}:supportsInterface`]: "0xffffffff" }
    expect((await readCollectionSummary(stubClient(bespoke), TOKEN))?.sale).toBe(null)
    const otherToken = { ...v2Token, ...v2Sale, [`${SALE}:collection`]: OWNER }
    expect((await readCollectionSummary(stubClient(otherToken), TOKEN))?.sale).toBe(null)
  })

  it("flags any v2 gate as gated", async () => {
    const gated = { ...v2Token, ...v2Sale, [`${SALE}:gate`]: OWNER }
    expect((await readCollectionSummary(stubClient(gated), TOKEN))?.sale?.gated).toBe(true)
  })

  it("detects a v1 token and its FixedPriceMinter", async () => {
    const v1: Table = {
      [`${TOKEN}:name`]: "Old",
      [`${TOKEN}:symbol`]: "OLD",
      [`${TOKEN}:version`]: 1n,
      [`${TOKEN}:owner`]: OWNER,
      [`${TOKEN}:primaryMinter`]: SALE,
      [`${TOKEN}:idMode`]: 0,
      [`${TOKEN}:config`]: [{ supplyCap: 50n }, 4n],
      [`${SALE}:collection`]: TOKEN,
      [`${SALE}:price`]: 5n,
      [`${SALE}:priceStrategy`]: ZERO,
      [`${SALE}:mintStart`]: 0n,
      [`${SALE}:mintEnd`]: 0n,
      [`${SALE}:maxMints`]: 0n,
      [`${SALE}:totalMinted`]: 4n,
      [`${SALE}:walletCap`]: 0n,
      [`${SALE}:allowlistRoot`]: `0x${"00".repeat(32)}`,
      [`${SALE}:referralShareBps`]: 1000,
      [`${SALE}:payoutRecipient`]: OWNER,
      [`${SALE}:priceOf`]: 5n,
    }
    const c = await readCollectionSummary(stubClient(v1), TOKEN)
    expect(c?.protocolVersion).toBe(1)
    expect(c?.sequential).toBe(true)
    expect(c?.supplyCap).toBe(50n)
    expect(c?.sale?.kind).toBe("v1-fixed-price")
    expect(c?.sale?.referralShareBps).toBe(1000)
    expect(c?.sale?.gated).toBe(false)
  })

  it("returns a read-only summary for a token with no version()", async () => {
    const legacy = { [`${TOKEN}:name`]: "Legacy" }
    const c = await readCollectionSummary(stubClient(legacy), TOKEN)
    expect(c?.protocolVersion).toBe(0)
    expect(c?.sale).toBe(null)
  })
})
