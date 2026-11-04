import { describe, expect, it } from "vitest"
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  encodeFunctionData,
} from "viem"
import { fixedPriceMinterAbi, fixedPriceSaleAbi } from "./abi"
import { buildMintRequest, describeMintError, MINT_CHAIN_ID } from "./mint-transaction"

const SALE = "0x1111111111111111111111111111111111111111" as const
const TO = "0x2222222222222222222222222222222222222222" as const
const REFERRER = "0x3333333333333333333333333333333333333333" as const

describe("Surface mint transaction", () => {
  it("mints a v2 sale through mintWithReferral with the site's referrer", () => {
    const request = buildMintRequest({
      sale: { kind: "v2-fixed-price", address: SALE },
      to: TO,
      quantity: 3n,
      referrer: REFERRER,
      value: 42n,
    })
    expect(request.chainId).toBe(1)
    expect(request.chainId).toBe(MINT_CHAIN_ID)
    expect(request.address).toBe(SALE)
    expect(request.functionName).toBe("mintWithReferral")
    expect(request.args).toEqual([TO, 3n, REFERRER, "0x"])
    expect(request.value).toBe(42n)
    // Encodes against the vendored sale ABI (catches an arg-order drift).
    const data = encodeFunctionData({
      abi: fixedPriceSaleAbi,
      functionName: "mintWithReferral",
      args: request.args,
    })
    expect(data.slice(0, 10)).toBe("0x063bd541")
  })

  it("mints a v1 FixedPriceMinter through the 4-arg mint overload", () => {
    const request = buildMintRequest({
      sale: { kind: "v1-fixed-price", address: SALE },
      to: TO,
      quantity: 1n,
      referrer: REFERRER,
      value: 7n,
    })
    expect(request.functionName).toBe("mint")
    expect(request.args).toEqual([TO, 1n, REFERRER, "0x"])
    const data = encodeFunctionData({
      abi: fixedPriceMinterAbi,
      functionName: "mint",
      args: request.args,
    })
    // mint(address,uint256,address,bytes), not the mint(uint256) overload.
    expect(data.slice(0, 10)).toBe("0xe97a7c21")
  })
})

describe("describeMintError", () => {
  function reverted(abi: typeof fixedPriceSaleAbi | typeof fixedPriceMinterAbi, errorName: string, args?: readonly unknown[]) {
    const data = encodeErrorResult({ abi, errorName, args } as Parameters<typeof encodeErrorResult>[0])
    const cause = new ContractFunctionRevertedError({ abi, data, functionName: "mint" })
    return new BaseError("Execution reverted", { cause })
  }

  it("decodes v2 sale reverts from the cause chain", () => {
    expect(describeMintError(reverted(fixedPriceSaleAbi, "SaleClosed"))).toBe("This sale is closed.")
    expect(describeMintError(reverted(fixedPriceSaleAbi, "WalletCapExceeded", [1n, 2n]))).toMatch(
      /mint limit/,
    )
  })

  it("decodes v1 minter reverts from the cause chain", () => {
    expect(describeMintError(reverted(fixedPriceMinterAbi, "NotAllowlisted"))).toMatch(/allowlist/)
  })

  it("falls back to a short message", () => {
    expect(describeMintError(new Error("boom\nstack"))).toBe("boom")
  })
})
