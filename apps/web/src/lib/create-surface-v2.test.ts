/**
 * SurfaceFactoryV2.createSurface arg encoding, mirrored against
 * DeployStep.tsx's submit() (studio create wizard): viem's
 * encodeFunctionData validates the tuple shapes against the real ABI, so a
 * misnamed/mistyped/missing field (e.g. forgetting to drop v1's
 * priceStrategy, or the trailing seedSource arg v2 adds) throws here before
 * any wallet signs a deploy tx.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { encodeFunctionData, decodeFunctionData, type Address } from "viem"
import { surfaceFactoryAbi, surfaceFactoryV2Abi } from "@pin/abi"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address
const OWNER = "0x1111111111111111111111111111111111111111" as Address

const cfg = {
  supplyCap: 100n,
  royaltyBps: 1000,
  royaltyReceiver: ZERO_ADDRESS,
  renderer: ZERO_ADDRESS,
  rendererLocked: false,
  supplyLocked: false,
} as const

// The wizard's v1 sale shape (buildSaleBase() + priceStrategy).
const saleV1 = {
  price: 10_000_000_000_000_000n,
  priceStrategy: ZERO_ADDRESS,
  mintStart: 0n,
  mintEnd: 0n,
  payoutRecipient: ZERO_ADDRESS,
  maxMints: 0n,
  allowlistRoot: ("0x" + "0".repeat(64)) as `0x${string}`,
  walletCap: 0n,
} as const

// v2 drops priceStrategy entirely (FixedPriceMinterV2 is exact-payment only).
const saleV2 = {
  price: saleV1.price,
  mintStart: saleV1.mintStart,
  mintEnd: saleV1.mintEnd,
  payoutRecipient: saleV1.payoutRecipient,
  maxMints: saleV1.maxMints,
  allowlistRoot: saleV1.allowlistRoot,
  walletCap: saleV1.walletCap,
} as const

test("v1 createSurface takes 6 args, no seedSource", () => {
  const data = encodeFunctionData({
    abi: surfaceFactoryAbi,
    functionName: "createSurface",
    args: ["Test", "TST", OWNER, cfg, saleV1, []],
  })
  const decoded = decodeFunctionData({ abi: surfaceFactoryAbi, data })
  assert.equal(decoded.functionName, "createSurface")
  assert.equal(decoded.args.length, 6)
})

test("v2 createSurface takes 7 args: v1's 6 plus a trailing seedSource", () => {
  const data = encodeFunctionData({
    abi: surfaceFactoryV2Abi,
    functionName: "createSurface",
    args: ["Test", "TST", OWNER, cfg, saleV2, [], ZERO_ADDRESS],
  })
  const decoded = decodeFunctionData({ abi: surfaceFactoryV2Abi, data })
  assert.equal(decoded.functionName, "createSurface")
  assert.equal(decoded.args.length, 7)
  assert.equal(decoded.args[6], ZERO_ADDRESS) // seedSource, no wizard UI yet
})

test("v2's SaleConfig has no priceStrategy field", () => {
  const createSurface = surfaceFactoryV2Abi.find(
    (x) => x.type === "function" && x.name === "createSurface",
  ) as unknown as { inputs: { name: string; components?: { name: string }[] }[] }
  const saleInput = createSurface.inputs.find((i) => i.name === "sale")
  const saleFields = saleInput?.components?.map((c) => c.name) ?? []
  assert.ok(!saleFields.includes("priceStrategy"), "v2 sale must not carry priceStrategy")
  assert.deepEqual(saleFields, [
    "price",
    "mintStart",
    "mintEnd",
    "payoutRecipient",
    "maxMints",
    "allowlistRoot",
    "walletCap",
  ])
})
