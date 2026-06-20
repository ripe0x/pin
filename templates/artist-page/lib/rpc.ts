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
// patterns this page actually uses (eth_call + archive eth_getLogs).
//
// The homepage enriches past (settled/cancelled) auctions by scanning the
// house's event history from its creation block forward. That is an *archive*
// getLogs query — it reads logs far older than the ~128 most recent blocks —
// and the bundled free RPCs have quietly stopped serving those for free:
//   - PublicNode now 403s archive getLogs ("Archive requests require a
//     personal token") — still fine for eth_call at `latest`, useless here.
//   - drpc free tier rejects ranges over 10k blocks.
//   - LlamaRPC has been intermittently 5xx-ing (Cloudflare 521).
//   - Cloudflare caps the range and errors generically on anything wider.
// With all four failing, viem retries + rotates across them per window and
// the build-time prerender of `/` blows past the host's 60s per-page budget.
//
// Tenderly's public gateway serves full-range archive getLogs (and eth_call)
// with no token and no signup — it answered the whole house scan in ~1.4s in
// testing — so it leads. The others stay on as fallbacks for eth_call and
// recent-log reads. Power users should still set NEXT_PUBLIC_RPC_URL to their
// own archive endpoint; it slots in ahead of all of these (see getRpcUrls).
//
// 1. Tenderly gateway — archive getLogs + eth_call, no token. Primary.
// 2. PublicNode — fast eth_call / recent logs; archive getLogs token-gated.
// 3. drpc.org — eth_call + getLogs in <=10k windows (the chunker shrinks to fit).
// 4. LlamaRPC — additional fallback.
// 5. Cloudflare — last resort; narrow getLogs range so demoted.
const PUBLIC_RPCS = [
  "https://gateway.tenderly.co/public/mainnet",
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

// Initial chunk size for `getLogs`. The primary provider (Tenderly gateway)
// accepts very wide ranges — it answered a ~390k-block window in one call —
// so we start high to minimize round-trips on the happy path. If a
// smaller-capped fallback answers instead (drpc 10k, Cloudflare 800), the
// shrink-on-error logic below narrows the window to fit. Observed caps:
// PublicNode 50k, drpc free tier 10k, Cloudflare ~800.
const INITIAL_CHUNK = 100_000n
// The smallest chunk we'll bother with before giving up. Kept below
// Cloudflare's ~800-block cap so even the stingiest provider can answer.
const MIN_CHUNK = 500n
// Stop range-too-large detection from running forever on a wedge.
const MAX_CHUNK_SHRINK_ATTEMPTS = 8

/**
 * Heuristic: does this error look like the RPC complaining the block
 * range is too wide? Different providers phrase it differently — match
 * loosely on common substrings. Observed messages:
 *   PublicNode: "exceed maximum block range: 50000"
 *   drpc:       "ranges over 10000 blocks are not supported on freetier"
 *   Cloudflare: "range too large. Max range: 800"
 *   Alchemy:    "Log response size exceeded" / "query returned more than 10000 results"
 */
function isRangeTooLarge(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return (
    msg.includes("block range") ||
    msg.includes("maximum block range") ||
    msg.includes("range is too") ||
    msg.includes("range too") ||
    msg.includes("max range") ||
    msg.includes("ranges over") ||
    msg.includes("are not supported") ||
    msg.includes("limit exceeded") ||
    msg.includes("response size") ||
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
    // `end` is derived from the *current* chunk size and is recomputed
    // whenever we shrink — otherwise a "range too large" retry would
    // re-issue the identical oversized query and fail forever.
    let end = cursor + chunk - 1n > toBlock ? toBlock : cursor + chunk - 1n
    let attempt = 0
    let succeeded = false
    while (!succeeded) {
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
        if (
          isRangeTooLarge(err) &&
          chunk > MIN_CHUNK &&
          attempt < MAX_CHUNK_SHRINK_ATTEMPTS
        ) {
          // Halve the chunk AND narrow `end` to match, then retry the now
          // smaller window from the same cursor.
          chunk = chunk / 2n > MIN_CHUNK ? chunk / 2n : MIN_CHUNK
          end = cursor + chunk - 1n > toBlock ? toBlock : cursor + chunk - 1n
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

/**
 * Race a promise against a hard deadline, resolving to `fallback` on timeout
 * instead of hanging.
 *
 * This is the backstop that keeps the build deterministic. The homepage
 * prerenders at build time and cold-scans this house's whole auction history;
 * a healthy scan finishes in a few seconds, but if every RPC in the chain is
 * failing or slow (exactly what broke this build when PublicNode started
 * 403-ing archive getLogs), viem's retry/rotate can drag the render past the
 * host's per-page budget (Netlify aborts a static page after 60s) and fail the
 * whole deploy. With a deadline we instead degrade to `fallback` (an empty
 * auction list) and let ISR (`revalidate`) repopulate on a later request once
 * the providers recover.
 *
 * The losing promise is intentionally left to settle in the background: if it
 * resolves after the deadline, its `unstable_cache` wrapper still stores the
 * real result, so the next request is served warm rather than rescanning.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}
