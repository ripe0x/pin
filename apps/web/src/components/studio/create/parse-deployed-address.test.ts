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
import { launcherAbi, surfaceFactoryV2Abi } from "@pin/abi"
import { parseDeployedCollectionAddress, parseLaunchedAddresses } from "./parse-deployed-address.ts"

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

// ── Surface v2 Launcher.launch ──────────────────────────────────────────────

const LAUNCHER = "0x7F3e9B843845Aa44A1860bB1C343D7554920Fb59" as Address
const SALE = "0x3333333333333333333333333333333333333333" as Address

function launchedReceipt(emitter: Address): TransactionReceipt {
  const topics = encodeEventTopics({
    abi: launcherAbi,
    eventName: "Launched",
    args: { owner: OWNER, collection: COLLECTION, sale: SALE },
  })
  return {
    logs: [
      {
        address: emitter,
        topics,
        data: "0x",
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

test("parses the collection and sale out of a Launched receipt", () => {
  assert.deepEqual(parseLaunchedAddresses(launchedReceipt(LAUNCHER), LAUNCHER), {
    collection: COLLECTION,
    sale: SALE,
  })
})

test("ignores a Launched log from any contract but the launcher", () => {
  assert.equal(parseLaunchedAddresses(launchedReceipt(FACTORY), LAUNCHER), null)
  assert.equal(parseLaunchedAddresses(undefined, LAUNCHER), null)
})
