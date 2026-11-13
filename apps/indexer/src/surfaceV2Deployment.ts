import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Reads the Surface v2 primitive addresses and deploy block for one network
 * out of the repo's deploy record (contracts/deployments.<network>.json,
 * filled by contracts/script/deploy.sh from the broadcast receipts).
 *
 * Record keys: `surfaceFactoryV2` is the token CloneFactory, `saleFactoryV2`
 * the sale CloneFactory, `launcherV2` the Launcher; `factoryDeployBlock`
 * is the block all three were deployed in.
 *
 * Returns null unless all three addresses are recorded. ponder.config.ts
 * calls this once per network (mainnet, sepolia) and omits that network's
 * key from each v2 contract's `chain: {...}` map on null, rather than
 * pointing it at the zero address: Ponder's `flattenSources` builds one
 * source per key actually present in `chain`, so an omitted network gets no
 * source, no `eth_getLogs` call, and no `ponder_sync.factories` row.
 */

type Address = `0x${string}`

export type SurfaceV2Deployment = {
  chainId: number
  tokenFactory: Address
  saleFactory: Address
  launcher: Address
  factoryDeployBlock: number
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const NETWORK_CHAIN_ID: Record<"mainnet" | "sepolia", number> = {
  mainnet: 1,
  sepolia: 11_155_111,
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const isAddress = (value: unknown): value is Address =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS

export function readSurfaceV2Deployment(
  network: "mainnet" | "sepolia",
): SurfaceV2Deployment | null {
  const path = resolve(repoRoot, `contracts/deployments.${network}.json`)
  if (!existsSync(path)) return null

  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  const { surfaceFactoryV2, saleFactoryV2, launcherV2, factoryDeployBlock, chainId } = record
  if (!isAddress(surfaceFactoryV2) || !isAddress(saleFactoryV2) || !isAddress(launcherV2)) return null
  if (typeof factoryDeployBlock !== "number") return null

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
    chainId: expectedChainId,
    tokenFactory: surfaceFactoryV2,
    saleFactory: saleFactoryV2,
    launcher: launcherV2,
    factoryDeployBlock,
  }
}
