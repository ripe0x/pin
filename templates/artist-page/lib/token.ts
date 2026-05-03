/**
 * Per-token reads — current owner, transfer/provenance history. These exist
 * separately from `lib/auctions.ts` because they're keyed by (tokenContract,
 * tokenId), not by the artist's house.
 */
import "server-only"
import { unstable_cache } from "next/cache"
import { parseAbiItem, type Address } from "viem"
import { erc721Abi } from "./abi"
import { getClient, getLogsChunked } from "./rpc"
import { SOVEREIGN_FACTORY_DEPLOY_BLOCK, ZERO_ADDRESS } from "./config"

// ─── Owner ──────────────────────────────────────────────────────────────────

const _getTokenOwnerCached = unstable_cache(
  async (
    tokenContract: Address,
    tokenId: string,
  ): Promise<Address | null> => {
    const client = getClient()
    try {
      const owner = await client.readContract({
        address: tokenContract,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      })
      return owner as Address
    } catch {
      // Token may not exist or contract may not implement ownerOf — return
      // null and let the caller drop the section.
      return null
    }
  },
  ["token-owner-v1"],
  { revalidate: 60, tags: ["token-owner"] },
)

export async function getTokenOwner(
  tokenContract: Address,
  tokenId: string,
): Promise<Address | null> {
  return _getTokenOwnerCached(tokenContract, tokenId)
}

// ─── Provenance ─────────────────────────────────────────────────────────────

/**
 * Single timeline row — what happened to this token at this block. The
 * caller renders these as a vertical list with from / to / timestamp /
 * tx-hash deep link, matching PND's `Provenance.tsx`.
 */
export type ProvenanceEntry = {
  event: "Minted" | "Transferred" | "Listed" | "Sold" | "Cancelled"
  from: Address
  to: Address | null
  /** Unix seconds. */
  blockTime: number
  txHash: `0x${string}`
}

// Note: we deliberately do NOT include `blockNumber` in `ProvenanceEntry`
// even though we use it for sorting. `unstable_cache` JSON-serializes
// return values for the disk cache, and bigints aren't JSON-safe — including
// one would throw a "Do not know how to serialize a BigInt" error on every
// cache write, silently breaking the cache. We sort inside the cached
// function instead.

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)

/**
 * Full provenance for a token. Composes:
 *  - ERC-721 `Transfer` events on the NFT contract (by indexed tokenId)
 *  - The artist's house's `AuctionCreated` / `AuctionEnded` / `AuctionCanceled`
 *    is already surfaced via the auction list, so we don't double-count
 *    those here — Transfer events to/from the house custody address are
 *    enough to imply Listed / Sold semantics and we relabel them.
 *
 * Cached for 5 minutes — provenance is essentially append-only on-chain
 * but a short TTL covers very-recent transfers.
 */
const _getTokenProvenanceCached = unstable_cache(
  async (
    tokenContract: Address,
    tokenId: string,
    houseAddress: Address | null,
  ): Promise<ProvenanceEntry[]> => {
    const client = getClient()
    const latest = await client.getBlockNumber().catch(() => null)
    if (latest === null) return []

    // Transfer scan — `tokenId` is indexed so this returns just the events
    // we care about. We bound the from-block at the SovereignAuctionHouse
    // factory deploy: a token listed on a Sovereign house has all its
    // custody-transfer activity (artist → house → winner) after that
    // block. Pre-factory mints and transfers are skipped — that data
    // isn't relevant to this page's "what happened around this auction"
    // story, and scanning earlier is expensive without indexer help.
    const logs = await getLogsChunked({
      address: tokenContract,
      event: transferEvent,
      args: { tokenId: BigInt(tokenId) },
      fromBlock: SOVEREIGN_FACTORY_DEPLOY_BLOCK,
      toBlock: latest,
    })

    if (logs.length === 0) return []

    const uniqueBlocks = Array.from(
      new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null)),
    )
    const blockTimes = new Map<bigint, number>()
    await Promise.all(
      uniqueBlocks.map(async (bn) => {
        try {
          const block = await client.getBlock({ blockNumber: bn })
          blockTimes.set(bn, Number(block.timestamp))
        } catch {
          blockTimes.set(bn, 0)
        }
      }),
    )

    const lowerHouse = houseAddress?.toLowerCase()

    // Sort newest first by blockNumber while we still have it as bigint,
    // then drop blockNumber from the returned shape so the value is
    // JSON-serializable (unstable_cache uses JSON for disk persistence,
    // and bigints aren't JSON-safe).
    const filtered = logs.filter(
      (l): l is typeof l & {
        blockNumber: bigint
        transactionHash: `0x${string}`
      } => l.blockNumber !== null && l.transactionHash !== null,
    )
    filtered.sort((a, b) => Number(b.blockNumber - a.blockNumber))

    const entries: ProvenanceEntry[] = filtered
      .map((l) => {
        const from = (l.args.from ?? ZERO_ADDRESS) as Address
        const to = (l.args.to ?? ZERO_ADDRESS) as Address
        const fromLower = from.toLowerCase()
        const toLower = to.toLowerCase()

        // Classify the transfer:
        //  - mint: from == 0x0
        //  - listed: NFT moved into the artist's house custody
        //  - sold: NFT moved from house custody to a non-house address
        //  - transferred: anything else
        let event: ProvenanceEntry["event"] = "Transferred"
        if (fromLower === ZERO_ADDRESS.toLowerCase()) {
          event = "Minted"
        } else if (lowerHouse && toLower === lowerHouse) {
          event = "Listed"
        } else if (lowerHouse && fromLower === lowerHouse) {
          event = "Sold"
        }

        return {
          event,
          from,
          to: to === ZERO_ADDRESS ? null : to,
          blockTime: blockTimes.get(l.blockNumber) ?? 0,
          txHash: l.transactionHash,
        }
      })

    return entries
  },
  ["token-provenance-v2"],
  { revalidate: 60 * 5, tags: ["token-provenance"] },
)

export async function getTokenProvenance(
  tokenContract: Address,
  tokenId: string,
  houseAddress: Address | null,
): Promise<ProvenanceEntry[]> {
  return _getTokenProvenanceCached(tokenContract, tokenId, houseAddress)
}
