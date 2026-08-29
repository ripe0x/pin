import type { PublicClient } from "viem"
import { throttleRpc } from "./throttle.ts"

const FALLBACK_CONFIRMATIONS = BigInt(
  Math.max(1, Number(process.env.FINALITY_CONFIRMATIONS ?? "64")),
)

export type FinalizedBoundary = {
  blockNumber: bigint
  rpcCalls: number
  source: "finalized" | "confirmations"
}

/**
 * Return a block that scanners can commit permanently. Ethereum RPCs should
 * support the finalized tag; the confirmation fallback keeps a provider
 * compatibility problem from silently turning into latest-head indexing.
 */
export async function getFinalizedBoundary(
  client: PublicClient,
): Promise<FinalizedBoundary> {
  try {
    await throttleRpc()
    const block = await client.getBlock({ blockTag: "finalized" })
    if (block.number === null) throw new Error("finalized block has no number")
    return { blockNumber: block.number, rpcCalls: 1, source: "finalized" }
  } catch (finalizedError) {
    await throttleRpc()
    const head = await client.getBlockNumber()
    if (head <= FALLBACK_CONFIRMATIONS) {
      throw new Error(
        `cannot derive finalized boundary at head ${head}: ${String(finalizedError)}`,
      )
    }
    return {
      blockNumber: head - FALLBACK_CONFIRMATIONS,
      rpcCalls: 2,
      source: "confirmations",
    }
  }
}
