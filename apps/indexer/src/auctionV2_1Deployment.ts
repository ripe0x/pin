import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Reads the Sovereign Auction House V2.1 factory address and deploy block
 * out of contracts/deployments.mainnet.json (keys `auctionHouseV2_1Factory`
 * and `auctionHouseV2_1FactoryDeployBlock`, filled by hand after the
 * DeployAuctionV2_1.s.sol broadcast, see docs/auction-house-migration-plan.md
 * "V2.1", deploy step 5).
 *
 * Returns null while V2.1 is undeployed: a missing, empty or zero factory
 * address, or a missing/non-positive deploy block. ponder.config.ts then
 * leaves the V2.1 factory and house contracts with an empty `chain: {}` map,
 * which Ponder turns into zero sources: no eth_getLogs, no
 * ponder_sync.factories row, and never a zero-address watch. Same contract
 * as surfaceV2Deployment.ts.
 */

type Address = `0x${string}`

export type AuctionV2_1Deployment = {
  factory: Address
  factoryDeployBlock: number
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const isAddress = (value: unknown): value is Address =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS

/** Pure parser over the record's JSON, split out for tests. */
export function parseAuctionV2_1Deployment(
  record: Record<string, unknown>,
): AuctionV2_1Deployment | null {
  const { auctionHouseV2_1Factory, auctionHouseV2_1FactoryDeployBlock, chainId } = record
  if (!isAddress(auctionHouseV2_1Factory)) return null
  if (chainId !== 1) {
    console.warn(
      `[auctionV2_1Deployment] contracts/deployments.mainnet.json has chainId ${String(chainId)}, ` +
        "expected 1. Ignoring auctionHouseV2_1Factory (treating V2.1 as undeployed).",
    )
    return null
  }
  if (
    typeof auctionHouseV2_1FactoryDeployBlock !== "number" ||
    !Number.isSafeInteger(auctionHouseV2_1FactoryDeployBlock) ||
    auctionHouseV2_1FactoryDeployBlock <= 0
  ) {
    // An address without a block would otherwise mean a genesis-to-head
    // factory scan. Loud, and not subscribed, until the block is recorded.
    console.warn(
      "[auctionV2_1Deployment] auctionHouseV2_1Factory is set but auctionHouseV2_1FactoryDeployBlock " +
        "is missing or not a positive integer. V2.1 is NOT subscribed until the deploy block is recorded.",
    )
    return null
  }
  return { factory: auctionHouseV2_1Factory, factoryDeployBlock: auctionHouseV2_1FactoryDeployBlock }
}

export function readAuctionV2_1Deployment(): AuctionV2_1Deployment | null {
  const path = resolve(repoRoot, "contracts/deployments.mainnet.json")
  if (!existsSync(path)) return null
  return parseAuctionV2_1Deployment(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
}
