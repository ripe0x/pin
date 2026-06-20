/**
 * Shared viem mainnet client for worker tasks.
 *
 * RPC strategy: multi-provider fallback chain, free public RPCs first,
 * paid Alchemy only as a last-resort backstop. No single provider is
 * reliable enough at our request volume; fallback transports try each in
 * order on failure, transparently.
 *
 * The worker scans the long tail incrementally, which means *archive*
 * eth_getLogs — reading logs older than the ~128 most recent blocks. The
 * free RPCs have changed under us and most no longer serve those:
 *   - publicnode now 403s archive getLogs ("Archive requests require a
 *     personal token") — still great for eth_call/multicall at `latest`.
 *   - llamarpc has been 5xx-ing (Cloudflare 521) and prunes archive state.
 *   - ankr (rpc.ankr.com/eth) is now fully key-gated — even eth_call returns
 *     -32000 Unauthorized without a key — so it was pure dead weight and is
 *     dropped from the chain.
 * Left unaddressed, every archive getLogs fell through all the free
 * providers to *paid* Alchemy. Tenderly's public gateway serves full-range
 * archive getLogs (and eth_call) with no token, so it now sits right behind
 * publicnode to catch those scans for free before we ever reach Alchemy.
 *
 * Order (free first, paid last):
 *   1. publicnode      — primary for the high-volume eth_call/multicall
 *                        traffic; archive getLogs token-gated (rotates off).
 *   2. tenderly        — archive getLogs + eth_call, no token. Catches the
 *                        historical scans publicnode refuses.
 *   3. llamarpc        — deep free eth_call fallback (self-heals; fast-fails
 *                        when its origin is down).
 *   4. drpc            — getLogs in short (<=10k) windows + trace; free tier.
 *   5. alchemy (paid)  — last-resort backstop. The worker's call volume is
 *                        bounded by `known_artists × scan cadence`, not by
 *                        traffic, so the rare fall-through here is pennies —
 *                        not a recurrence of the v1 "every page render fires
 *                        chain reads" bill.
 *
 * Per-transport `timeout: 8_000` keeps a stuck provider from blocking
 * the whole chain. `batch: true` reduces RPC count when viem can batch
 * multiple calls into a single JSON-RPC request.
 */
import { createPublicClient, fallback, http, type PublicClient } from "viem"
import { mainnet } from "viem/chains"

function getTransports() {
  // drpc is stored under ALCHEMY_MAINNET_URL for legacy reasons — see the
  // workspace's env conventions.
  const drpcUrl = process.env.ALCHEMY_MAINNET_URL
  const alchemyKey = process.env.ALCHEMY_API_KEY
  const alchemyUrl =
    alchemyKey && !alchemyKey.startsWith("set-")
      ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
      : null

  const opts = { batch: true, timeout: 8_000 } as const

  // Free public RPCs first, then the env-provided drpc + paid Alchemy
  // backstop (see the order rationale in the file header).
  const urls: (string | null | undefined)[] = [
    "https://ethereum-rpc.publicnode.com",
    "https://gateway.tenderly.co/public/mainnet",
    "https://eth.llamarpc.com",
    drpcUrl,
    alchemyUrl,
  ]

  // De-dupe while preserving order — drpcUrl/alchemyUrl can collide with a
  // public URL (or each other) depending on how the service env is set.
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const u of urls) {
    if (!u || seen.has(u)) continue
    seen.add(u)
    ordered.push(u)
  }

  return ordered.map((u) => http(u, opts))
}

export const client: PublicClient = createPublicClient({
  chain: mainnet,
  transport: fallback(getTransports(), { retryCount: 1, retryDelay: 200 }),
})

/**
 * Dedicated trace_filter client. The free public RPCs in our fallback
 * chain (publicnode, tenderly, llamarpc) don't implement trace_filter at
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
