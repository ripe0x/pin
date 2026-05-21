/**
 * Shared viem mainnet client for worker tasks.
 *
 * RPC strategy: multi-provider fallback chain across free public RPCs.
 * No single provider is reliable enough at our request volume; drpc
 * free tier times out under load, individual public RPCs have varying
 * uptime. Fallback transports try each in order on failure, transparently.
 *
 * Order (most-reliable first, observed empirically):
 *   1. publicnode      — most reliable for eth_getLogs + eth_call
 *   2. llamarpc        — solid backup
 *   3. ankr            — solid backup
 *   4. drpc            — works for short windows; included so its
 *                        free-tier quota actually gets used
 *   5. alchemy (paid)  — last-resort backstop. The worker's call volume
 *                        is bounded by `known_artists × scan cadence`,
 *                        not by traffic, so even falling all the way
 *                        through to paid Alchemy is pennies/day in
 *                        practice — not a recurrence of the v1
 *                        "every page render fires chain reads" bill.
 *
 * Per-transport `timeout: 8_000` keeps a stuck provider from blocking
 * the whole chain. `batch: true` reduces RPC count when viem can batch
 * multiple calls into a single JSON-RPC request.
 */
import { createPublicClient, fallback, http, type PublicClient } from "viem"
import { mainnet } from "viem/chains"

function getTransports() {
  const drpcUrl = process.env.ALCHEMY_MAINNET_URL
  const alchemyKey = process.env.ALCHEMY_API_KEY
  const alchemyUrl =
    alchemyKey && !alchemyKey.startsWith("set-")
      ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
      : null

  const opts = { batch: true, timeout: 8_000 } as const

  const transports = [
    http("https://ethereum-rpc.publicnode.com", opts),
    http("https://eth.llamarpc.com", opts),
    http("https://rpc.ankr.com/eth", opts),
  ]

  // drpc (currently stored under ALCHEMY_MAINNET_URL for legacy reasons —
  // see the workspace's env conventions). Only add if it's actually a
  // distinct URL, not pointing back at one of the public RPCs above.
  if (drpcUrl && !transports.some((_, i) =>
    [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com",
      "https://rpc.ankr.com/eth",
    ][i] === drpcUrl,
  )) {
    transports.push(http(drpcUrl, opts))
  }

  if (alchemyUrl && alchemyUrl !== drpcUrl) {
    transports.push(http(alchemyUrl, opts))
  }

  return transports
}

export const client: PublicClient = createPublicClient({
  chain: mainnet,
  transport: fallback(getTransports(), { retryCount: 1, retryDelay: 200 }),
})

/**
 * Dedicated trace_filter client. The free public RPCs in our fallback
 * chain (publicnode, llamarpc, ankr) don't implement trace_filter at
 * all — but they take ~8s to time out before viem's fallback moves on
 * to drpc. That wasted latency stacks: per-artist scan-manifold does
 * ~200 trace chunks × ~24s wasted overhead = ~80 min of pure stall.
 * This client skips the fallback for trace operations and goes directly
 * to drpc (the only one that supports them). Use only for trace_*
 * methods.
 */
function getTraceUrl(): string {
  const drpcUrl = process.env.ALCHEMY_MAINNET_URL
  if (drpcUrl) return drpcUrl
  // Fallback to Alchemy paid if drpc isn't configured; Alchemy also
  // supports trace_filter on archive plans.
  const alchemyKey = process.env.ALCHEMY_API_KEY
  if (alchemyKey && !alchemyKey.startsWith("set-")) {
    return `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
  }
  throw new Error("[worker] no trace_filter-capable RPC configured")
}

export const traceClient: PublicClient = createPublicClient({
  chain: mainnet,
  transport: http(getTraceUrl(), { timeout: 30_000 }),
})
