/**
 * Pulls the deployed collection address out of a createSurface receipt's
 * SurfaceCreated log. Selects the v1 or v2 factory ABI by `isV2` (the
 * event shape is identical between them, but decoding still needs the
 * ABI that matches the contract that actually emitted it). Plain
 * function (no React/Next import), split out of DeployStep.tsx so it is
 * unit-testable without a component-render harness.
 */
import { parseEventLogs, type Address, type TransactionReceipt } from "viem"
import { surfaceFactoryAbi, surfaceFactoryV2Abi } from "@pin/abi"

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
