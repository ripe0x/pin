import "server-only"
import {
  createPublicClient,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { MINT_FACTORY, MAINNET_CHAIN_ID } from "@pin/addresses"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  CollectorTokenRef,
  AdapterLastSale,
} from "./types"
import {
  readMintArtistTokens,
  writeMintArtistTokens,
} from "../lazy-index"
import { loggingFallbackTransport } from "../rpc-log"
import { isKnownArtist } from "../known-artists"
import { MAX_BLOCKS_PER_SCAN } from "../external-indexer"

const MINT_FACTORY_ADDR = MINT_FACTORY[MAINNET_CHAIN_ID]

// Mint Factory deployed Nov 2024 in tx
// 0x57b1ad0587f0ec24f4341d3abcf988ea0396b2bc3662f131fc42ffa0446ce650
// at block 21_167_599. Lower bound for the Factory `Created` scan.
const MINT_FACTORY_DEPLOY_BLOCK = 21_167_599n

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// Factory event: emitted on each per-artist collection deploy (via
// `create` or `clone`). `ownerAddress` is indexed → cheap topic-filtered
// scan returns just this artist's clones.
const createdEvent = parseAbiItem(
  "event Created(address indexed ownerAddress, address contractAddress)",
)

// ERC-1155 mint events. We filter `from = 0x0` to capture mints (and
// only mints — secondary transfers don't constitute "new work by the
// artist"). The per-contract `Mint.create(...)` function emits a
// `TransferSingle` from `0x0` when the artist mints their initial copy.
const transferSingleEvent = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
)
const transferBatchEvent = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
)

// Block-range chunk for indexed-arg log scans. Mirrors the TL adapter
// (drpc + Alchemy comfortably handle 2M-block windows with topic
// filters).
const BLOCK_RANGE = 2_000_000n

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: loggingFallbackTransport("mint", { batch: true }),
  })
}

async function paginatedIndexedScan<T>(
  scan: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<T[]> {
  const chunks: Array<[bigint, bigint]> = []
  for (let start = fromBlock; start <= toBlock; start += BLOCK_RANGE) {
    const end =
      start + BLOCK_RANGE - 1n > toBlock ? toBlock : start + BLOCK_RANGE - 1n
    chunks.push([start, end])
  }
  const results = await Promise.all(
    chunks.map(async ([start, end]) => {
      try {
        return await scan(start, end)
      } catch {
        if (end - start > 10_000n) {
          const mid = start + (end - start) / 2n
          const [a, b] = await Promise.all([
            paginatedIndexedScan(scan, start, mid),
            paginatedIndexedScan(scan, mid + 1n, end),
          ])
          return [...a, ...b]
        }
        return [] as T[]
      }
    }),
  )
  return results.flat()
}

/**
 * Incremental scan: writes new Mint protocol mint rows for `artist`
 * since the previous successful scan. Called by `refreshArtist` in
 * `lib/external-indexer.ts` (cron + refresh-button entrypoints).
 *
 * Two stages:
 *   1. Factory — `Created(ownerAddress, contractAddress)` filtered by
 *      indexed `ownerAddress = artist`. We scan the FULL Factory
 *      history every refresh (not bounded by the incremental cursor)
 *      because clones are sparse per artist and the topic-filtered
 *      query is cheap; this also avoids needing a separate
 *      `lazy_mint_contracts` cache table.
 *   2. Per clone — `TransferSingle` + `TransferBatch` with `from = 0x0`
 *      between the artist's `last_scanned_block` cursor and `toBlock`,
 *      bounded by `MAX_BLOCKS_PER_SCAN`. ERC-1155 editions can share a
 *      tokenId, but the unique (contract, tokenId) row is upserted via
 *      `ON CONFLICT DO UPDATE` so the gallery sees one row per token.
 *
 * Cursor: `lazy_mint_artist_status.last_scanned_block`. Null on first
 * scan → start from `MINT_FACTORY_DEPLOY_BLOCK`.
 *
 * Gated by `isKnownArtist`.
 */
export async function scanMintArtistTokens(
  artist: Address,
): Promise<{ caughtUp: boolean }> {
  if (!(await isKnownArtist(artist))) return { caughtUp: true }

  const existing = await readMintArtistTokens(artist)
  const fromBlock =
    existing?.lastScannedBlock != null
      ? existing.lastScannedBlock + 1n
      : MINT_FACTORY_DEPLOY_BLOCK

  const client = getClient()
  const latest = await client.getBlockNumber()
  if (fromBlock > latest) {
    await writeMintArtistTokens(artist, [], latest)
    return { caughtUp: true }
  }

  const budgetEnd = fromBlock + MAX_BLOCKS_PER_SCAN - 1n
  const toBlock = budgetEnd < latest ? budgetEnd : latest

  // Stage 1 — discover the artist's clones. Always scan full Factory
  // history: indexed `ownerAddress` makes this a sparse query (typically
  // 0–3 results per artist) and the alternative (a separate cache table
  // tracked by its own cursor) buys nothing for Mint's contract volume.
  const factoryLogs = await paginatedIndexedScan(
    (from, to) =>
      client.getLogs({
        address: MINT_FACTORY_ADDR,
        event: createdEvent,
        args: { ownerAddress: artist },
        fromBlock: from,
        toBlock: to,
      }),
    MINT_FACTORY_DEPLOY_BLOCK,
    latest,
  )
  // Per-clone deploy blocks let us avoid scanning before the clone
  // existed (saves a few empty getLogs calls on cold artists).
  const clones = new Map<Address, bigint>()
  for (const log of factoryLogs) {
    const args = log.args as { contractAddress?: Address }
    if (!args.contractAddress || log.blockNumber === null) continue
    const existing = clones.get(args.contractAddress)
    if (existing === undefined || log.blockNumber < existing) {
      clones.set(args.contractAddress, log.blockNumber)
    }
  }

  // Stage 2 — per-clone mint scan over the incremental window.
  type Ref = {
    contract: Address
    tokenId: string
    blockNumber: bigint
    logIndex: number
  }
  const refs: Ref[] = []
  for (const [contract, deployBlock] of clones) {
    const cloneStart = fromBlock > deployBlock ? fromBlock : deployBlock
    if (cloneStart > toBlock) continue

    const [singleLogs, batchLogs] = await Promise.all([
      paginatedIndexedScan(
        (from, to) =>
          client.getLogs({
            address: contract,
            event: transferSingleEvent,
            args: { from: ZERO_ADDRESS as Address },
            fromBlock: from,
            toBlock: to,
          }),
        cloneStart,
        toBlock,
      ),
      paginatedIndexedScan(
        (from, to) =>
          client.getLogs({
            address: contract,
            event: transferBatchEvent,
            args: { from: ZERO_ADDRESS as Address },
            fromBlock: from,
            toBlock: to,
          }),
        cloneStart,
        toBlock,
      ),
    ])

    for (const l of singleLogs) {
      if (l.blockNumber === null || l.logIndex === null) continue
      const args = l.args as { id?: bigint }
      if (args.id === undefined) continue
      refs.push({
        contract,
        tokenId: args.id.toString(),
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
      })
    }
    for (const l of batchLogs) {
      if (l.blockNumber === null || l.logIndex === null) continue
      const args = l.args as { ids?: readonly bigint[] }
      if (!args.ids) continue
      for (const id of args.ids) {
        refs.push({
          contract,
          tokenId: id.toString(),
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
        })
      }
    }
  }

  await writeMintArtistTokens(artist, refs, toBlock)
  return { caughtUp: toBlock >= latest }
}

/**
 * Mint protocol platform adapter.
 *
 * Pure-read on the request path: `discoverArtistTokens` only consults
 * Postgres. The scan that populates the table is `scanMintArtistTokens`
 * above, invoked by the cron + the "Refresh my work" button via
 * `refreshArtist` in `lib/external-indexer.ts`.
 *
 * Mint has no marketplace integration today — collection contracts are
 * ERC-1155s with fixed-price mints handled inside the contract itself;
 * there's no auction-house event stream to surface in our home grid or
 * token-detail bid panel. `getLastSale` returns null (same as Manifold).
 */
export const mintAdapter: PlatformAdapter = {
  id: "mint",
  displayName: "Mint",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    const cached = await readMintArtistTokens(artist)
    if (!cached) return []
    return cached.tokens.map((t) => ({
      platform: "mint",
      contract: t.contract as Address,
      tokenId: t.tokenId,
      blockNumber: t.blockNumber,
      logIndex: t.logIndex,
      collectionName: null,
    }))
  },

  async discoverCollectorTokens(): Promise<CollectorTokenRef[]> {
    // Collector-side enumeration deferred — would require either
    // iterating known Mint clone contracts or an Alchemy NFT API
    // ownership query gated by the Mint contract classifier (cf.
    // Manifold's `supportsInterface` probe). Out of scope for parity
    // with the initial Manifold/SR/TL feature set.
    return []
  },

  async getLastSale(): Promise<AdapterLastSale | null> {
    // No marketplace integration today (see adapter docstring).
    return null
  },
}
