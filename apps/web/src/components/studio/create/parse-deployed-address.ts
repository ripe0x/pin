/**
 * Pulls the deployed collection address out of a deploy receipt. Two
 * shapes: a SurfaceFactory createSurface receipt's SurfaceCreated log (the
 * v1 or superseded v2 factory ABI by `isV2`: the event shape is identical
 * between them, but decoding still needs the ABI that matches the contract
 * that actually emitted it), and a Surface v2 Launcher.launch receipt's
 * Launched log (collection + its sale). Plain functions (no React/Next
 * import), split out of DeployStep.tsx so they are unit-testable without a
 * component-render harness.
 */
import { parseEventLogs, type Address, type TransactionReceipt } from "viem"
import { launcherAbi, surfaceFactoryAbi, surfaceFactoryV2Abi } from "@pin/abi"

export function parseDeployedCollectionAddress(
  receipt: TransactionReceipt | undefined,
  isV2: boolean,
): Address | null {
  if (!receipt) return null
  try {
    const logs = parseEventLogs({
      abi: isV2 ? surfaceFactoryV2Abi : surfaceFactoryAbi,
      logs: receipt.logs,
      eventName: "SurfaceCreated",
    })
    return (logs[0]?.args as { collection?: Address } | undefined)?.collection ?? null
  } catch {
    return null
  }
}

/** The collection and sale a Launcher.launch receipt deployed, from its
 *  Launched(owner, collection, sale) log. Only logs emitted by `launcher`
 *  count, so a look-alike event from another contract in the same
 *  transaction is ignored. */
export function parseLaunchedAddresses(
  receipt: TransactionReceipt | undefined,
  launcher: Address,
): { collection: Address; sale: Address } | null {
  if (!receipt) return null
  try {
    const logs = parseEventLogs({ abi: launcherAbi, logs: receipt.logs, eventName: "Launched" }).filter(
      (l) => l.address.toLowerCase() === launcher.toLowerCase(),
    )
    const args = logs[0]?.args as { collection?: Address; sale?: Address } | undefined
    return args?.collection && args.sale ? { collection: args.collection, sale: args.sale } : null
  } catch {
    return null
  }
}
