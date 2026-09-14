/**
 * parseDeployedCollectionAddress: pulls the collection address out of a
 * createSurface receipt's SurfaceCreated log, selecting the v1 or v2
 * factory ABI by `isV2`. The event shape is byte-identical between v1 and
 * v2 (same signature hash), so this pins that a v2 receipt still decodes
 * correctly when told to use the v2 ABI.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { encodeAbiParameters, encodeEventTopics, type Address, type TransactionReceipt } from "viem"
import { surfaceFactoryV2Abi } from "@pin/abi"
import { parseDeployedCollectionAddress } from "./parse-deployed-address.ts"

const FACTORY = "0xe4449989D9504D1d734204222AeB543514974C1E" as Address
const OWNER = "0x1111111111111111111111111111111111111111" as Address
const COLLECTION = "0xB9dc8743Fd28d40EE9A6D5D8406af0A454D2050E" as Address
const MINTER = "0x2222222222222222222222222222222222222222" as Address

function surfaceCreatedReceipt(): TransactionReceipt {
  const topics = encodeEventTopics({
    abi: surfaceFactoryV2Abi,
    eventName: "SurfaceCreated",
    args: { owner: OWNER, collection: COLLECTION },
  })
  const data = encodeAbiParameters(
    [
      { name: "primaryMinter", type: "address" },
      { name: "idMode", type: "uint8" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
    ],
    [MINTER, 0, "Test", "TST"],
  )
  return {
    logs: [
      {
        address: FACTORY,
        topics,
        data,
        blockHash: "0x0000000000000000000000000000000000000000000000000000000000000001" as const,
        blockNumber: 1n,
        logIndex: 0,
        transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000002" as const,
        transactionIndex: 0,
        removed: false,
      },
    ],
  } as unknown as TransactionReceipt
}

test("parses a v2 SurfaceCreated receipt with the v2 ABI", () => {
  const receipt = surfaceCreatedReceipt()
  assert.equal(parseDeployedCollectionAddress(receipt, true), COLLECTION)
})

test("returns null for an undefined receipt", () => {
  assert.equal(parseDeployedCollectionAddress(undefined, true), null)
})
