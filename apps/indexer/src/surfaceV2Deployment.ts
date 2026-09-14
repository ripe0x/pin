import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Reads the Surface v2 factory address and deploy block for one network
 * out of the repo's deploy record (contracts/deployments.<network>.json,
 * written by contracts/script/DeploySurfaceV2.s.sol on a real broadcast).
 *
 * Returns null when v2 has no factory recorded for that network yet.
 * ponder.config.ts calls this once per network (mainnet, sepolia) and
 * falls back to the zero address when null, so the SurfaceFactoryV2/
 * SurfaceV2/FixedPriceMinterV2 contracts stay unconditionally present
 * in `contracts` on every network: the zero address never emits a log,
 * so an undeployed network costs one empty eth_getLogs range, not a
 * missing key. See ponder.config.ts's per-chain `chain: {mainnet, sepolia}`
 * declarations for those three contracts.
 */

export type SurfaceV2Deployment = {
  chainId: number
  surfaceFactoryV2: `0x${string}`
  factoryDeployBlock: number
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

export function readSurfaceV2Deployment(
  network: "mainnet" | "sepolia",
): SurfaceV2Deployment | null {
  const path = resolve(repoRoot, `contracts/deployments.${network}.json`)
  if (!existsSync(path)) return null

  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  const factory = record.surfaceFactoryV2
  if (
    typeof factory !== "string" ||
    factory === "" ||
    factory.toLowerCase() === ZERO_ADDRESS
  ) {
    return null
  }

  const deployBlock = record.factoryDeployBlock
  if (typeof deployBlock !== "number") return null

  return {
    chainId: record.chainId as number,
    surfaceFactoryV2: factory as `0x${string}`,
    factoryDeployBlock: deployBlock,
  }
}
