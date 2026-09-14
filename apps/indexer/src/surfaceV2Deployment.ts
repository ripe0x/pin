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
 * omits that network's key from the contract's `chain: {...}` map on
 * null, rather than pointing it at the zero address: Ponder's
 * `flattenSources` builds one source per key actually present in
 * `chain`, so an omitted network gets no source, no `eth_getLogs` call,
 * and no `ponder_sync.factories` row. See ponder.config.ts's per-chain
 * `chain: {mainnet, sepolia}` declarations for
 * SurfaceFactoryV2/SurfaceV2/FixedPriceMinterV2.
 */

export type SurfaceV2Deployment = {
  chainId: number
  surfaceFactoryV2: `0x${string}`
  factoryDeployBlock: number
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const NETWORK_CHAIN_ID: Record<"mainnet" | "sepolia", number> = {
  mainnet: 1,
  sepolia: 11_155_111,
}

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

  const chainId = record.chainId
  const expectedChainId = NETWORK_CHAIN_ID[network]
  if (chainId !== expectedChainId) {
    console.warn(
      `[surfaceV2Deployment] contracts/deployments.${network}.json has chainId ` +
        `${String(chainId)}, expected ${expectedChainId} for network "${network}". ` +
        "Ignoring this record (treating Surface v2 as undeployed on this network).",
    )
    return null
  }

  return {
    chainId,
    surfaceFactoryV2: factory as `0x${string}`,
    factoryDeployBlock: deployBlock,
  }
}
