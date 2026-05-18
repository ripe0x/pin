/**
 * Shared viem mainnet client for worker tasks.
 *
 * RPC strategy mirrors the v1 doc:
 *   - `ALCHEMY_MAINNET_URL` (paid) for the worker scanners. Worker volume
 *     is bounded by `known_artists` count × per-platform scan cadence, so
 *     the paid endpoint earns its keep here.
 *   - Public fallbacks are NOT enabled at the transport layer because the
 *     worker is the only consumer; a transient Alchemy hiccup just means
 *     the cursor doesn't advance and the next iteration retries from the
 *     same block. No user is waiting on this.
 */
import { createPublicClient, http, type PublicClient } from "viem"
import { mainnet } from "viem/chains"

function getRpcUrl(): string {
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return explicit
  const key = process.env.ALCHEMY_API_KEY
  if (key) return `https://eth-mainnet.g.alchemy.com/v2/${key}`
  console.error(
    "[worker] ALCHEMY_API_KEY / ALCHEMY_MAINNET_URL unset — exiting",
  )
  process.exit(1)
}

export const client: PublicClient = createPublicClient({
  chain: mainnet,
  transport: http(getRpcUrl(), { batch: true }),
})
