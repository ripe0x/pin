/**
 * RPC client + transport with public-RPC failover and dynamic
 * `getLogs` chunk sizing.
 *
 * The template ships with a curated chain of free public RPCs (chain 1)
 * so non-technical artists can deploy with no signup. Power users can set
 * `NEXT_PUBLIC_RPC_URL` (single) or `NEXT_PUBLIC_RPC_URLS` (comma-sep'd
 * chain) to override — their URLs become the primary, public RPCs become
 * fallbacks beneath them.
 *
 * The block-range a given RPC will accept on `eth_getLogs` varies (Cloudflare
 * caps at ~1024, Alchemy/PublicNode/drpc allow much more). Rather than guess,
 * `getLogsChunked` adapts: it starts at a generous chunk size and shrinks
 * (with retry) when it sees the typical "block range too large" error.
 */
import {
  createPublicClient,
  fallback,
  http,
  type Address,
  type AbiEvent,
  type GetLogsReturnType,
} from "viem"
import { mainnet } from "viem/chains"
import { getConfig } from "./config"

// Curated public RPCs for chain 1, ordered by suitability for the read
// patterns this page actually uses (eth_call + eth_getLogs).
//
// 1. PublicNode — generous getLogs range, reliable.
// 2. drpc.org — decentralized, also good getLogs support.
// 3. LlamaRPC — additional fallback.
// 4. Cloudflare — last resort; getLogs capped at ~1024 blocks so demoted.
const PUBLIC_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://eth.llamarpc.com",
  "https://cloudflare-eth.com",
]

function getRpcUrls(): string[] {
  const { userRpcUrls } = getConfig()
  if (userRpcUrls && userRpcUrls.length > 0) {
    // User-specified URLs take priority. Public RPCs slot in beneath them
    // as fallbacks — if the user's key is rate-limited or rotated, the
    // page degrades gracefully instead of failing.
    return [...userRpcUrls, ...PUBLIC_RPCS]
  }
  return PUBLIC_RPCS
}

let _client: ReturnType<typeof createPublicClient> | null = null

/**
 * A viem public client backed by viem's built-in `fallback` transport. The
 * fallback transport rotates to the next URL on rate-limit / 5xx errors and
 * remembers which one is healthy across calls within the same client.
 */
export function getClient() {
  if (_client) return _client
  const urls = getRpcUrls()
  _client = createPublicClient({
    chain: mainnet,
    transport: fallback(
      urls.map((url) =>
        http(url, {
          // viem's default retryCount is 3; keep it modest so failures
          // surface quickly and the fallback transport rotates.
          retryCount: 1,
          timeout: 15_000,
        }),
      ),
      { rank: false },
    ),
  })
  return _client
}

// Initial chunk size for `getLogs` — large enough that PublicNode/drpc do
// the whole house-history scan in just a few calls. Cloudflare will reject
// this, and we'll shrink-and-retry below.
const INITIAL_CHUNK = 100_000n
// The smallest chunk we'll bother with before giving up. 1024 matches
// Cloudflare's documented cap.
const MIN_CHUNK = 1024n
// Stop range-too-large detection from running forever on a wedge.
const MAX_CHUNK_SHRINK_ATTEMPTS = 6

/**
 * Heuristic: does this error look like the RPC complaining the block
 * range is too wide? Different providers phrase it differently — match
 * loosely on common substrings.
 */
function isRangeTooLarge(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return (
    msg.includes("block range") ||
    msg.includes("range is too") ||
    msg.includes("range too") ||
    msg.includes("limit exceeded") ||
    msg.includes("query returned more than") ||
    msg.includes("more than 10000")
  )
}

export type GetLogsChunkedArgs<TEvent extends AbiEvent> = {
  address: Address
  event: TEvent
  args?: Record<string, unknown>
  fromBlock: bigint
  toBlock: bigint
}

/**
 * `eth_getLogs` against a single contract, chunking the block range to
 * fit whatever the active RPC accepts. Adapts on the fly: starts at a
 * generous chunk, shrinks when the RPC complains, and remembers the
 * working size for the rest of this scan.
 */
export async function getLogsChunked<TEvent extends AbiEvent>(
  argsIn: GetLogsChunkedArgs<TEvent>,
): Promise<GetLogsReturnType<TEvent>> {
  const client = getClient()
  const { address, event, args, fromBlock, toBlock } = argsIn

  if (toBlock < fromBlock) return [] as unknown as GetLogsReturnType<TEvent>

  const all: GetLogsReturnType<TEvent> = [] as unknown as GetLogsReturnType<TEvent>
  let cursor = fromBlock
  let chunk = INITIAL_CHUNK

  while (cursor <= toBlock) {
    const end = cursor + chunk - 1n > toBlock ? toBlock : cursor + chunk - 1n
    let attempt = 0
    let succeeded = false
    while (attempt < MAX_CHUNK_SHRINK_ATTEMPTS && !succeeded) {
      try {
        // viem types `getLogs` with a complex generic; the runtime accepts
        // these args fine but the type narrowing across our generic event
        // doesn't compose perfectly. Cast at the call boundary only.
        const logs = (await client.getLogs({
          address,
          event,
          args: args as never,
          fromBlock: cursor,
          toBlock: end,
        })) as GetLogsReturnType<TEvent>
        ;(all as unknown as unknown[]).push(...(logs as unknown as unknown[]))
        succeeded = true
      } catch (err) {
        if (isRangeTooLarge(err) && chunk > MIN_CHUNK) {
          // Halve and retry the same window with a smaller chunk size.
          chunk = chunk / 2n > MIN_CHUNK ? chunk / 2n : MIN_CHUNK
          attempt++
          continue
        }
        // Any other failure: swallow and skip the window. Returning a
        // partial list is preferable to crashing the page render — the
        // user sees what we have, retries on next ISR regen.
        if (process.env.NODE_ENV !== "production") {
          console.warn("[rpc] getLogs window failed", { cursor, end, err })
        }
        succeeded = true
      }
    }
    cursor = end + 1n
  }
  return all
}
