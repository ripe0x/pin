/**
 * On-demand artist token discovery via direct RPC calls.
 *
 * Finds all tokens an artist minted on Foundation — both the shared NFT
 * contract and any per-artist collection contracts deployed via the
 * NFTCollectionFactory.
 *
 * No indexer dependency — works with just an RPC endpoint + IPFS gateways.
 */
import { unstable_cache } from "next/cache"
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { foundationNftAbi, collectionFactoryAbi, erc721Abi } from "@pin/abi"
import { getAssetTransfers, getOwnersForNft } from "./alchemy"
import { pgCache } from "./pg-cache"
import {
  FOUNDATION_NFT,
  COLLECTION_FACTORY_V1,
  COLLECTION_FACTORY_V2,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import { extractCid, fetchFromIpfs, ipfsToHttp } from "@pin/shared"
import {
  discoverManifoldTokens,
  discoverManifoldTokenRefs,
} from "./manifold-discovery"
import { mapWithConcurrency } from "./concurrency"
import {
  readFoundationArtistTokens,
  writeFoundationArtistTokens,
  LAZY_TTL,
  isFresh,
} from "./lazy-index"

const FOUNDATION_NFT_ADDRESS = FOUNDATION_NFT[MAINNET_CHAIN_ID]
const FACTORY_V1 = COLLECTION_FACTORY_V1[MAINNET_CHAIN_ID]
const FACTORY_V2 = COLLECTION_FACTORY_V2[MAINNET_CHAIN_ID]

// Block when the FoundationNFT contract was deployed
const SHARED_DEPLOY_BLOCK = 11_907_800n

// Block range for factories (V1 deployed later, but we start from shared deploy to be safe)
const FACTORY_V1_DEPLOY_BLOCK = 14_000_000n
const FACTORY_V2_DEPLOY_BLOCK = 15_000_000n

// Alchemy supports large ranges for indexed event filtering
const BLOCK_RANGE = 2_000_000n

export type DiscoveredToken = {
  tokenId: string
  contract: Address
  creator: Address
  tokenUri: string | null
  metadataCid: string | null
  mediaCid: string | null
  metadata: {
    name?: string
    description?: string
    image?: string
  } | null
  mediaHttpUrl: string | null
  /** Name of the collection (null for shared contract tokens) */
  collectionName: string | null
}

/**
 * Lightweight reference to a token. Cheap to discover (event logs only — no
 * `tokenURI`, no IPFS) and JSON-serializable so it can be the cache key for
 * paginated enrichment. Sort fields are advisory: not all sources populate
 * them (Manifold tokens via Alchemy NFT API have no on-chain log context),
 * which is why they're at the bottom of the type rather than required.
 */
export type TokenRef = {
  contract: Address
  tokenId: string
  creator: Address
  collectionName: string | null
}

function getClient() {
  return createPublicClient({
    chain: mainnet,
    // `batch: true` collapses concurrent JSON-RPC calls (within the same
    // tick) into a single batched POST. Critical for the per-transfer
    // `getBlock` fan-out below — N parallel reads become 1 HTTP request,
    // same total CU cost upstream but much less HTTP overhead. Alchemy
    // supports JSON-RPC batching natively.
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ?? "https://eth.llamarpc.com",
      { batch: true },
    ),
  })
}

// Foundation's Minted event on the shared contract
const mintedEvent = parseAbiItem(
  "event Minted(address indexed creator, uint256 indexed tokenId, string indexed indexedTokenIPFSPath, string tokenIPFSPath)",
)

// ERC-721 Transfer event for scanning collection contracts
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)

/**
 * Discover all tokens minted by an artist on Foundation, fully enriched.
 *
 * Kept for callers that need the complete data set in one shot (e.g. the
 * Open Graph image route, which needs media URLs to render thumbnails).
 * For the artist gallery, prefer `discoverArtistTokenRefs` + `enrichTokens`
 * so that enrichment is paginated.
 */
export async function discoverArtistTokens(
  artistAddress: string,
): Promise<DiscoveredToken[]> {
  const client = getClient()
  const artist = artistAddress.toLowerCase() as Address
  const latestBlock = await client.getBlockNumber()

  // Run all three sources in parallel — they don't share work.
  const [sharedTokens, collectionTokens, manifoldTokens] = await Promise.all([
    discoverSharedContractTokens(client, artist, latestBlock),
    discoverCollectionTokens(client, artist, latestBlock),
    discoverManifoldTokens(artist),
  ])

  return [...sharedTokens, ...collectionTokens, ...manifoldTokens]
}

/**
 * Discover only the tokens Foundation was pinning: shared FoundationNFT
 * contract + per-artist collection contracts deployed via NFTCollectionFactory.
 * Used by /preserve, where the goal is to take over pinning from Foundation.
 * Manifold tokens are intentionally excluded — Foundation never pinned those.
 */
export async function discoverFoundationPinnedTokens(
  artistAddress: string,
): Promise<DiscoveredToken[]> {
  const client = getClient()
  const artist = artistAddress.toLowerCase() as Address
  const latestBlock = await client.getBlockNumber()

  const [sharedTokens, collectionTokens] = await Promise.all([
    discoverSharedContractTokens(client, artist, latestBlock),
    discoverCollectionTokens(client, artist, latestBlock),
  ])

  return [...sharedTokens, ...collectionTokens]
}

/**
 * Cheap discovery: scan event logs across all three sources and return a
 * deduped, sort-stable list of `TokenRef`s. No `tokenURI`, no `ownerOf`,
 * no IPFS — those happen later in `enrichTokens` for the visible page.
 *
 * Sort: Foundation refs (with known block numbers) are newest-first, then
 * Manifold refs (no log context) appended in the order Alchemy returned them.
 */
export async function discoverArtistTokenRefs(
  artistAddress: string,
): Promise<TokenRef[]> {
  const client = getClient()
  const artist = artistAddress.toLowerCase() as Address

  // Lazy index read for the Foundation side. If a fresh row exists for
  // this artist, return it without RPC — replaces 7+ parallel `eth_getLogs`
  // scans (1 shared Minted + 6 collection-factory event streams + per-
  // collection Transfer scans) with a single Postgres point query.
  const cached = await readFoundationArtistTokens(artist)
  const useCache =
    cached !== null && isFresh(cached.lastIndexedAt, LAZY_TTL.foundationArtistTokens)

  const latestBlock = await client.getBlockNumber()

  const [sharedRefs, collectionRefs, manifoldRefs] = await Promise.all([
    useCache
      ? Promise.resolve([] as SortableRef[])
      : discoverSharedContractRefs(client, artist, latestBlock),
    useCache
      ? Promise.resolve([] as SortableRef[])
      : discoverCollectionRefs(client, artist, latestBlock),
    discoverManifoldTokenRefs(artist),
  ])

  // When the cache is fresh, hydrate cached rows into SortableRefs.
  // Otherwise we just ran the RPC scans above; persist their result for
  // the next miss before returning.
  let indexerFoundationSortable: SortableRef[] = []
  if (useCache && cached) {
    indexerFoundationSortable = cached.refs.map((r) => ({
      contract: r.contract as Address,
      tokenId: r.tokenId,
      creator: artist,
      collectionName: null,
      blockNumber: r.blockNumber,
      logIndex: r.logIndex,
    }))
  } else {
    const allFoundationRefs = [...sharedRefs, ...collectionRefs]
    writeFoundationArtistTokens(
      artist,
      allFoundationRefs.map((r) => ({
        contract: r.contract,
        tokenId: r.tokenId,
        blockNumber: r.blockNumber,
        logIndex: r.logIndex,
      })),
    )
  }

  // Newest-first within Foundation sources (block desc, logIndex desc).
  const foundationSorted = [
    ...indexerFoundationSortable,
    ...sharedRefs,
    ...collectionRefs,
  ].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber > b.blockNumber ? -1 : 1
    }
    return b.logIndex - a.logIndex
  })

  // Strip sort metadata so the result is small + JSON-stable for cache keys.
  const stripped: TokenRef[] = [
    ...foundationSorted.map(({ blockNumber: _b, logIndex: _l, ...r }) => r),
    ...manifoldRefs,
  ]

  // Dedupe by contract:tokenId — a token theoretically could surface across
  // sources (very rare; cheap insurance).
  const seen = new Set<string>()
  return stripped.filter((r) => {
    const key = `${r.contract.toLowerCase()}:${r.tokenId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Enrich a slice of refs with metadata. Designed to be called per page
 * (e.g. 24 tokens) so that the wall-clock cost scales with what the user
 * actually sees, not what the artist has ever minted.
 *
 * Uses `resolveTokenMetadataDirect` per token (which handles ERC-721 /
 * ERC-1155 / `data:` URIs / `{id}` substitution) under bounded concurrency
 * so a single slow IPFS gateway doesn't stall the whole page.
 */
export async function enrichTokens(
  refs: readonly TokenRef[],
): Promise<DiscoveredToken[]> {
  if (refs.length === 0) return []

  const client = getClient()

  const enriched = await mapWithConcurrency<TokenRef, DiscoveredToken | null>(refs, 8, async (ref) => {
    // Run metadata fetch and burn-check in parallel. The mint-log scan that
    // produced these refs doesn't track burns, so a token can be in the list
    // even after it's been transferred to 0x0 — `ownerOf` then reverts. We
    // filter those out so the gallery doesn't render ghost cards.
    const [meta, ownerProbe] = await Promise.all([
      resolveTokenMetadataDirect(ref.contract, ref.tokenId),
      client
        .readContract({
          address: ref.contract as Address,
          abi: erc721Abi,
          functionName: "ownerOf",
          args: [BigInt(ref.tokenId)],
        })
        .then((o) => ({ ok: true, owner: o as string }) as const)
        .catch(() => ({ ok: false }) as const),
    ])

    // Drop ERC-721 tokens that have been burned. ERC-1155 contracts don't
    // implement `ownerOf`, so the call reverts for them too — but ERC-1155
    // metadata reliably comes back via `uri(id)`, so we use the heuristic:
    // burned only when ownerOf reverted AND metadata fetch returned null.
    if (!ownerProbe.ok && !meta) return null
    if (ownerProbe.ok && ownerProbe.owner.toLowerCase() === ZERO_ADDRESS) {
      return null
    }

    const image = meta?.image ?? null
    const mediaHttpUrl = image ? ipfsToHttp(image) : null
    return {
      tokenId: ref.tokenId,
      contract: ref.contract,
      creator: ref.creator,
      tokenUri: null,
      metadataCid: null,
      mediaCid: image ? extractCid(image) : null,
      metadata:
        meta?.name || meta?.description || meta?.image
          ? {
              name: meta?.name,
              description: meta?.description,
              image: meta?.image,
            }
          : null,
      mediaHttpUrl,
      collectionName: ref.collectionName,
    } satisfies DiscoveredToken
  })

  return enriched.filter((t): t is DiscoveredToken => t !== null)
}

// ── Shared contract discovery ────────────────────────────────────────────────

type SortableRef = TokenRef & { blockNumber: bigint; logIndex: number }

async function discoverSharedContractTokens(
  client: ReturnType<typeof createPublicClient>,
  artist: Address,
  latestBlock: bigint,
): Promise<DiscoveredToken[]> {
  const mintLogs = await getLogs(
    client,
    FOUNDATION_NFT_ADDRESS,
    mintedEvent,
    { creator: artist },
    SHARED_DEPLOY_BLOCK,
    latestBlock,
  )

  if (mintLogs.length === 0) return []

  const tokenIds = mintLogs.map(
    (log) => (log as { args: { tokenId: bigint } }).args.tokenId,
  )

  return resolveTokenMetadata(client, FOUNDATION_NFT_ADDRESS, tokenIds, artist, null)
}

async function discoverSharedContractRefs(
  client: ReturnType<typeof createPublicClient>,
  artist: Address,
  latestBlock: bigint,
): Promise<SortableRef[]> {
  const mintLogs = await getLogs(
    client,
    FOUNDATION_NFT_ADDRESS,
    mintedEvent,
    { creator: artist },
    SHARED_DEPLOY_BLOCK,
    latestBlock,
  )

  return mintLogs.map((log) => {
    const l = log as {
      args: { tokenId: bigint }
      blockNumber: bigint | null
      logIndex: number | null
    }
    return {
      contract: FOUNDATION_NFT_ADDRESS,
      tokenId: l.args.tokenId.toString(),
      creator: artist,
      collectionName: null,
      blockNumber: l.blockNumber ?? 0n,
      logIndex: l.logIndex ?? 0,
    }
  })
}

// ── Collection contract discovery ────────────────────────────────────────────

type CollectionInfo = {
  address: Address
  name: string
}

async function discoverCollectionTokens(
  client: ReturnType<typeof createPublicClient>,
  artist: Address,
  latestBlock: bigint,
): Promise<DiscoveredToken[]> {
  // Find all collection contracts created by this artist across both factories
  const collections = await findArtistCollections(client, artist, latestBlock)

  if (collections.length === 0) return []

  // For each collection, find all minted tokens (Transfer from 0x0)
  const allTokens: DiscoveredToken[] = []

  for (const collection of collections) {
    const mintLogs = await getLogs(
      client,
      collection.address,
      transferEvent,
      { from: "0x0000000000000000000000000000000000000000" as Address },
      FACTORY_V1_DEPLOY_BLOCK,
      latestBlock,
    )

    if (mintLogs.length === 0) continue

    const tokenIds = mintLogs.map(
      (log) => (log as { args: { tokenId: bigint } }).args.tokenId,
    )

    const tokens = await resolveTokenMetadata(
      client,
      collection.address,
      tokenIds,
      artist,
      collection.name,
    )
    allTokens.push(...tokens)
  }

  return allTokens
}

async function discoverCollectionRefs(
  client: ReturnType<typeof createPublicClient>,
  artist: Address,
  latestBlock: bigint,
): Promise<SortableRef[]> {
  const collections = await findArtistCollections(client, artist, latestBlock)
  if (collections.length === 0) return []

  // Collections in parallel — each does one paginated getLogs.
  const perCollection = await mapWithConcurrency(
    collections,
    4,
    async (collection) => {
      const mintLogs = await getLogs(
        client,
        collection.address,
        transferEvent,
        { from: "0x0000000000000000000000000000000000000000" as Address },
        FACTORY_V1_DEPLOY_BLOCK,
        latestBlock,
      )
      return mintLogs.map((log) => {
        const l = log as {
          args: { tokenId: bigint }
          blockNumber: bigint | null
          logIndex: number | null
        }
        return {
          contract: collection.address,
          tokenId: l.args.tokenId.toString(),
          creator: artist,
          collectionName: collection.name,
          blockNumber: l.blockNumber ?? 0n,
          logIndex: l.logIndex ?? 0,
        } satisfies SortableRef
      })
    },
  )

  return perCollection.flat()
}

async function findArtistCollections(
  client: ReturnType<typeof createPublicClient>,
  artist: Address,
  latestBlock: bigint,
): Promise<CollectionInfo[]> {
  const collections: CollectionInfo[] = []

  // Modern 1/1 collection event
  const nftCollectionEvent = parseAbiItem(
    "event NFTCollectionCreated(address indexed collection, address indexed creator, uint256 indexed version, string name, string symbol, uint256 nonce)",
  )

  // Legacy pre-rename 1/1 collection event — identical layout, different name.
  // Foundation's V1 factory originally emitted `CollectionCreated`; early
  // collections still show up under this topic0 and would otherwise be missed.
  const legacyCollectionEvent = parseAbiItem(
    "event CollectionCreated(address indexed collection, address indexed creator, uint256 indexed version, string name, string symbol, uint256 nonce)",
  )

  const dropCollectionEvent = parseAbiItem(
    "event NFTDropCollectionCreated(address indexed collection, address indexed creator, address indexed approvedMinter, string name, string symbol, string baseURI, bool isRevealed, uint256 maxTokenId, address paymentAddress, uint256 version, uint256 nonce)",
  )

  // Scan V1 and V2 factories in parallel for modern, legacy, and drop events.
  const [
    v1Collections,
    v1Legacy,
    v1Drops,
    v2Collections,
    v2Legacy,
    v2Drops,
  ] = await Promise.all([
    getLogs(client, FACTORY_V1, nftCollectionEvent, { creator: artist }, FACTORY_V1_DEPLOY_BLOCK, latestBlock),
    getLogs(client, FACTORY_V1, legacyCollectionEvent, { creator: artist }, FACTORY_V1_DEPLOY_BLOCK, latestBlock),
    getLogs(client, FACTORY_V1, dropCollectionEvent, { creator: artist }, FACTORY_V1_DEPLOY_BLOCK, latestBlock),
    getLogs(client, FACTORY_V2, nftCollectionEvent, { creator: artist }, FACTORY_V2_DEPLOY_BLOCK, latestBlock),
    getLogs(client, FACTORY_V2, legacyCollectionEvent, { creator: artist }, FACTORY_V2_DEPLOY_BLOCK, latestBlock),
    getLogs(client, FACTORY_V2, dropCollectionEvent, { creator: artist }, FACTORY_V2_DEPLOY_BLOCK, latestBlock),
  ])

  for (const log of [...v1Collections, ...v1Legacy, ...v2Collections, ...v2Legacy]) {
    const args = (log as { args: { collection: Address; name: string } }).args
    collections.push({ address: args.collection, name: args.name })
  }

  for (const log of [...v1Drops, ...v2Drops]) {
    const args = (log as { args: { collection: Address; name: string } }).args
    collections.push({ address: args.collection, name: args.name })
  }

  // Dedupe by collection address — a contract theoretically could surface in
  // both the legacy and modern event streams (very unlikely, but cheap to guard).
  const seen = new Set<string>()
  return collections.filter((c) => {
    const key = c.address.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Generic paginated log fetcher with automatic range splitting on failure.
 */
async function getLogs(
  client: ReturnType<typeof createPublicClient>,
  address: Address,
  event: ReturnType<typeof parseAbiItem>,
  args: Record<string, unknown>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<unknown[]> {
  const allLogs: unknown[] = []

  for (let start = fromBlock; start <= toBlock; start += BLOCK_RANGE) {
    const end = start + BLOCK_RANGE - 1n > toBlock ? toBlock : start + BLOCK_RANGE - 1n
    try {
      const logs = await client.getLogs({
        address,
        event: event as any,
        args,
        fromBlock: start,
        toBlock: end,
      })
      allLogs.push(...logs)
    } catch {
      // If range too large, split in half and retry
      if (end - start > 10_000n) {
        const mid = start + (end - start) / 2n
        const firstHalf = await getLogs(client, address, event, args, start, mid)
        const secondHalf = await getLogs(client, address, event, args, mid + 1n, end)
        allLogs.push(...firstHalf, ...secondHalf)
      }
    }
  }

  return allLogs
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/**
 * Resolve tokenURI and IPFS metadata for a list of tokens on a given contract.
 * Filters out burned tokens (ownerOf reverts or returns 0x0).
 */
async function resolveTokenMetadata(
  client: ReturnType<typeof createPublicClient>,
  contract: Address,
  tokenIds: bigint[],
  creator: Address,
  collectionName: string | null,
): Promise<DiscoveredToken[]> {
  // Run multicall batches in parallel rather than serially so the wall-clock
  // cost stays reasonable when a single contract has many tokens to enrich.
  const batches: bigint[][] = []
  for (let i = 0; i < tokenIds.length; i += 50) {
    batches.push(tokenIds.slice(i, i + 50))
  }

  const perBatch = await mapWithConcurrency(batches, 3, async (batchIds) => {
    const calls = batchIds.flatMap((tokenId) => [
      {
        address: contract,
        abi: erc721Abi,
        functionName: "ownerOf" as const,
        args: [tokenId] as const,
      },
      {
        address: contract,
        abi: erc721Abi,
        functionName: "tokenURI" as const,
        args: [tokenId] as const,
      },
    ])

    const results = await client.multicall({ contracts: calls })

    const enriched = await mapWithConcurrency(
      batchIds,
      8,
      async (tokenId, j) => {
        const ownerResult = results[j * 2]
        const uriResult = results[j * 2 + 1]

        // Skip burned tokens — ownerOf reverts or returns zero address
        if (ownerResult.status !== "success") return null
        const owner = ownerResult.result as string
        if (owner.toLowerCase() === ZERO_ADDRESS) return null

        const tokenUri =
          uriResult.status === "success" ? (uriResult.result as string) : null

        let metadataCid: string | null = null
        let mediaCid: string | null = null
        let metadata: DiscoveredToken["metadata"] = null
        let mediaHttpUrl: string | null = null

        if (tokenUri) {
          metadataCid = extractCid(tokenUri)

          try {
            // Try each IPFS gateway in turn for IPFS URIs; fall back to
            // single-shot fetch for non-IPFS schemes.
            const res = metadataCid
              ? await fetchFromIpfs(metadataCid, { cache: "no-store" })
              : await fetch(tokenUri, { signal: AbortSignal.timeout(10_000) })
            if (res.ok) {
              metadata = await res.json()
              if (metadata?.image) {
                mediaCid = extractCid(metadata.image)
                mediaHttpUrl = ipfsToHttp(metadata.image)
              }
            }
          } catch {
            // Metadata fetch failed — token still gets included with null metadata
          }
        }

        return {
          tokenId: tokenId.toString(),
          contract,
          creator,
          tokenUri,
          metadataCid,
          mediaCid,
          metadata,
          mediaHttpUrl,
          collectionName,
        } satisfies DiscoveredToken
      },
    )

    return enriched.filter((t): t is DiscoveredToken => t !== null)
  })

  return perBatch.flat()
}

// ── Single token data resolution (for token detail page) ────────────────────

export type TokenOnChainData = {
  owner: string | null
  creator: string | null
  transfers: {
    from: string
    to: string
    blockNumber: bigint
    txHash: string
    timestamp: number
  }[]
}

/**
 * Resolve owner, creator, and transfer history for a single token via RPC.
 *
 * Cached for 60s. Owner can change on transfer/sale, but the artwork is
 * static and bot/refresh traffic shouldn't rescan the full transfer history
 * on every render. The auction page surfaces live bid state via a separate
 * 30s cache — no need for instant transfer freshness here.
 */
export async function getTokenOnChainData(
  contractAddress: string,
  tokenId: string,
): Promise<TokenOnChainData> {
  const cached = await getTokenOnChainDataCached(
    contractAddress.toLowerCase(),
    tokenId,
  )
  return hydrateTokenOnChainData(cached)
}

type SerializedTokenOnChainData = {
  owner: string | null
  creator: string | null
  transfers: Array<{
    from: string
    to: string
    blockNumber: string
    txHash: string
    timestamp: number
  }>
}

function hydrateTokenOnChainData(
  s: SerializedTokenOnChainData,
): TokenOnChainData {
  return {
    ...s,
    transfers: s.transfers.map((t) => ({ ...t, blockNumber: BigInt(t.blockNumber) })),
  }
}

const getTokenOnChainDataCached = unstable_cache(
  (contractAddress: string, tokenId: string) =>
    pgCache<SerializedTokenOnChainData>(
      `token-onchain-data:${contractAddress}:${tokenId}`,
      60,
      async () => {
        const data = await getTokenOnChainDataUncached(contractAddress, tokenId)
        return {
          ...data,
          transfers: data.transfers.map((t) => ({
            ...t,
            blockNumber: t.blockNumber.toString(),
          })),
        }
      },
    ),
  ["token-onchain-data-v1"],
  { revalidate: 60, tags: ["token-onchain-data"] },
)

async function getTokenOnChainDataUncached(
  contractAddress: string,
  tokenId: string,
): Promise<TokenOnChainData> {
  const client = getClient()
  const contract = contractAddress as Address
  const id = BigInt(tokenId)

  // Fetch owner and creator in parallel
  const [ownerResult, creatorResult] = await Promise.all([
    client
      .readContract({
        address: contract,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [id],
      })
      .catch(() => null),
    // tokenCreator is Foundation-specific — only exists on the shared contract
    client
      .readContract({
        address: contract,
        abi: foundationNftAbi,
        functionName: "tokenCreator",
        args: [id],
      })
      .catch(() => null),
  ])

  const owner = ownerResult ? (ownerResult as string) : null
  let creator = creatorResult ? (creatorResult as string) : null

  // ERC721 transfer history: keep the targeted indexed-topic `getLogs`
  // filter. Alchemy charges this cheaply because the topic is indexed, and
  // it only returns transfers for *this* token (typically 2–5 entries).
  //
  // We tried migrating this to `alchemy_getAssetTransfers`, but the API
  // doesn't accept a tokenId filter — for a high-token-count contract like
  // Foundation's shared NFT, the page-walk through every transfer in the
  // contract took 18s+. The targeted log filter wins decisively here.
  const latestBlock = await client.getBlockNumber()
  const transferLogs = await getLogs(
    client,
    contract,
    transferEvent,
    { tokenId: id },
    SHARED_DEPLOY_BLOCK,
    latestBlock,
  )

  // Resolve block timestamps. Two optimizations vs. the naive per-transfer
  // fetch we had before:
  //   1. Dedupe by block number — multiple transfers can land in the same
  //      block (mint+transfer atomically), so we only need one fetch per
  //      unique block.
  //   2. The transport above has `batch: true`, so the parallel fetches
  //      collapse into a single batched JSON-RPC POST regardless of count.
  const uniqueBlockNumbers = Array.from(
    new Set(
      (transferLogs as Array<{ blockNumber: bigint }>).map((l) => l.blockNumber),
    ),
  )
  const blockTimestamps = new Map<bigint, number>()
  await Promise.all(
    uniqueBlockNumbers.map(async (bn) => {
      try {
        const block = await client.getBlock({ blockNumber: bn })
        blockTimestamps.set(bn, Number(block.timestamp))
      } catch {
        blockTimestamps.set(bn, 0)
      }
    }),
  )

  const transfers = transferLogs.map((log) => {
    const l = log as {
      args: { from: string; to: string; tokenId: bigint }
      blockNumber: bigint
      transactionHash: string
    }
    return {
      from: l.args.from,
      to: l.args.to,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
      timestamp: blockTimestamps.get(l.blockNumber) ?? 0,
    }
  })

  // Derive creator from mint event if tokenCreator() is unavailable (custom collections)
  if (!creator && transfers.length > 0) {
    const mint = transfers.find(
      (t) => t.from === "0x0000000000000000000000000000000000000000",
    )
    if (mint) creator = mint.to
  }

  return { owner, creator, transfers }
}

const erc1155UriAbi = [
  {
    type: "function",
    name: "uri",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
] as const

const supportsInterfaceAbi = [
  {
    type: "function",
    name: "supportsInterface",
    inputs: [{ name: "iid", type: "bytes4" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const

const transferSingleEvent = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
)

export type Erc1155Stats = {
  creator: Address | null
  totalSupply: bigint
  ownerCount: number
  transfers: Array<{
    from: Address
    to: Address
    amount: bigint
    timestamp: number
    txHash: string
  }>
}

const ERC1155_INTERFACE_ID = "0xd9b67a26" as const
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address

/**
 * Fetch ERC1155-specific stats for a token: edition supply, holder count,
 * creator (the recipient of the first mint), and full transfer history with
 * per-transfer amounts. Returns null if the contract isn't ERC1155.
 *
 * Implementation note: TransferSingle's `id` is non-indexed, so we can't filter
 * by topic. We fetch all TransferSingle events on the contract and filter in
 * memory by token ID. For collections with many tokens this can be a lot of
 * logs — acceptable for v1, would benefit from indexer caching long-term.
 * TransferBatch is intentionally skipped (rare in practice; can add later).
 */
export async function getErc1155TokenStats(
  contractAddress: string,
  tokenId: string,
): Promise<Erc1155Stats | null> {
  // 10-min cache: TransferSingle events are non-indexed by id so we full-
  // contract scan and filter in memory — by far the most expensive read in the
  // app for ERC1155 tokens. Settled transfer history is immutable; only the
  // head is dynamic, so a longer TTL is safe and dramatically reduces miss
  // rate under bot/crawler traffic. /api/revalidate flushes the
  // `erc1155-stats` tag + pgCache prefix when an event needs to land sooner.
  const cached = await getErc1155TokenStatsCached(
    contractAddress.toLowerCase(),
    tokenId,
  )
  return cached ? hydrateErc1155Stats(cached) : null
}

const ERC1155_STATS_TTL_S = 600

type SerializedErc1155Stats = {
  creator: Address | null
  totalSupply: string
  ownerCount: number
  transfers: Array<{
    from: Address
    to: Address
    amount: string
    timestamp: number
    txHash: string
  }>
}

function hydrateErc1155Stats(s: SerializedErc1155Stats): Erc1155Stats {
  return {
    ...s,
    totalSupply: BigInt(s.totalSupply),
    transfers: s.transfers.map((t) => ({ ...t, amount: BigInt(t.amount) })),
  }
}

const getErc1155TokenStatsCached = unstable_cache(
  (contractAddress: string, tokenId: string) =>
    pgCache<SerializedErc1155Stats | null>(
      `erc1155-stats:${contractAddress}:${tokenId}`,
      ERC1155_STATS_TTL_S,
      async () => {
        const stats = await getErc1155TokenStatsUncached(
          contractAddress,
          tokenId,
        )
        if (!stats) return null
        return {
          ...stats,
          totalSupply: stats.totalSupply.toString(),
          transfers: stats.transfers.map((t) => ({
            ...t,
            amount: t.amount.toString(),
          })),
        }
      },
    ),
  ["erc1155-token-stats-v1"],
  { revalidate: ERC1155_STATS_TTL_S, tags: ["erc1155-stats"] },
)

// Per-contract cache for the underlying transfer stream. ERC1155
// TransferSingle's `id` is non-indexed, so we have to fetch every transfer on
// the contract and filter in JS. Caching the stream once per contract means
// sibling tokens (very common on Manifold creator cores) skip the expensive
// `alchemy_getAssetTransfers` call entirely on a warm cache.
type CachedTransferStream = {
  isErc1155: boolean
  transfers: Array<{
    from: Address
    to: Address
    tokenIdHex: string
    amountStr: string
    blockNumHex: string
    timestamp: number
    txHash: string
  }>
}

const getErc1155TransferStream = unstable_cache(
  (contractAddress: string) =>
    pgCache<CachedTransferStream>(
      `erc1155-transfer-stream:${contractAddress}`,
      ERC1155_STATS_TTL_S,
      () => fetchErc1155TransferStream(contractAddress),
    ),
  ["erc1155-transfer-stream-v1"],
  { revalidate: ERC1155_STATS_TTL_S, tags: ["erc1155-stats"] },
)

async function fetchErc1155TransferStream(
  contractAddress: string,
): Promise<CachedTransferStream> {
  const client = getClient()
  const contract = contractAddress as Address

  const isErc1155 = await client
    .readContract({
      address: contract,
      abi: supportsInterfaceAbi,
      functionName: "supportsInterface",
      args: [ERC1155_INTERFACE_ID],
    })
    .catch(() => false)

  if (!isErc1155) return { isErc1155: false, transfers: [] }

  const rawTransfers = await getAssetTransfers({
    contractAddresses: [contractAddress],
    category: ["erc1155"],
    order: "asc",
  })

  const transfers: CachedTransferStream["transfers"] = []
  for (const t of rawTransfers) {
    const meta = t.erc1155Metadata ?? []
    for (const m of meta) {
      transfers.push({
        from: t.from as Address,
        to: (t.to ?? ZERO_ADDR) as Address,
        tokenIdHex: m.tokenId,
        amountStr: BigInt(m.value).toString(),
        blockNumHex: t.blockNum,
        timestamp: t.metadata?.blockTimestamp
          ? Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000)
          : 0,
        txHash: t.hash,
      })
    }
  }
  return { isErc1155: true, transfers }
}

async function getErc1155TokenStatsUncached(
  contractAddress: string,
  tokenId: string,
): Promise<Erc1155Stats | null> {
  const tokenIdBig = BigInt(tokenId)

  const [stream, owners] = await Promise.all([
    getErc1155TransferStream(contractAddress),
    getOwnersForNft(contractAddress, tokenId),
  ])

  if (!stream.isErc1155) return null

  type MatchedTransfer = {
    from: Address
    to: Address
    amount: bigint
    blockNum: bigint
    timestamp: number
    txHash: string
  }
  const matching: MatchedTransfer[] = []
  for (const t of stream.transfers) {
    let mid: bigint
    try {
      mid = BigInt(t.tokenIdHex)
    } catch {
      continue
    }
    if (mid !== tokenIdBig) continue
    matching.push({
      from: t.from,
      to: t.to,
      amount: BigInt(t.amountStr),
      blockNum: BigInt(t.blockNumHex),
      timestamp: t.timestamp,
      txHash: t.txHash,
    })
  }

  if (matching.length === 0) {
    return { creator: null, totalSupply: 0n, ownerCount: 0, transfers: [] }
  }

  // Replay in chronological order to compute total supply + identify creator.
  matching.sort((a, b) => Number(a.blockNum - b.blockNum))

  let totalSupply = 0n
  let creator: Address | null = null
  for (const m of matching) {
    if (m.from === ZERO_ADDR) {
      totalSupply += m.amount
      if (creator === null) creator = m.to
    }
    if (m.to === ZERO_ADDR) totalSupply -= m.amount
  }

  // Newest-first for display.
  const transfers: Erc1155Stats["transfers"] = matching
    .slice()
    .reverse()
    .map(({ from, to, amount, timestamp, txHash }) => ({
      from,
      to,
      amount,
      timestamp,
      txHash,
    }))

  return { creator, totalSupply, ownerCount: owners.length, transfers }
}

/**
 * Resolve metadata for a single token directly via RPC + IPFS. Tries ERC721's
 * `tokenURI(id)` first; if that reverts (the contract is ERC1155 or doesn't
 * implement the call), falls back to ERC1155's `uri(id)`. ERC1155 URIs may
 * contain a `{id}` placeholder per the spec which we substitute with the
 * lowercase hex token ID padded to 64 chars.
 */
export async function resolveTokenMetadataDirect(
  contractAddress: string,
  tokenId: string,
): Promise<{ name?: string; description?: string; image?: string } | null> {
  // Token metadata at a specific (contract, tokenId) is effectively immutable
  // in 99% of cases (IPFS-pinned URIs are content-addressed). Cache for 1h —
  // long enough to absorb refresh traffic, short enough that mutable on-chain
  // renderers stay reasonably fresh. Use lowercased contract for cache key
  // stability.
  return resolveTokenMetadataCached(contractAddress.toLowerCase(), tokenId)
}

const resolveTokenMetadataCached = unstable_cache(
  async (contractAddress: string, tokenId: string) =>
    pgCache(
      `token-metadata:${contractAddress}:${tokenId}`,
      60 * 60,
      () => resolveTokenMetadataUncached(contractAddress, tokenId),
    ),
  ["token-metadata-v1"],
  { revalidate: 60 * 60, tags: ["token-metadata"] },
)

async function resolveTokenMetadataUncached(
  contractAddress: string,
  tokenId: string,
): Promise<{ name?: string; description?: string; image?: string } | null> {
  const client = getClient()
  const id = BigInt(tokenId)
  const contract = contractAddress as Address

  const uriString = await client
    .readContract({
      address: contract,
      abi: erc721Abi,
      functionName: "tokenURI",
      args: [id],
    })
    .catch(() =>
      client
        .readContract({
          address: contract,
          abi: erc1155UriAbi,
          functionName: "uri",
          args: [id],
        })
        .catch(() => null),
    )

  if (!uriString) return null

  // ERC1155 spec: substitute {id} with hex-padded token id (lowercase, 64 chars).
  const idHex = id.toString(16).padStart(64, "0")
  const resolvedUri = (uriString as string).replace(/\{id\}/g, idHex)

  // On-chain renderers (e.g. zorbs) return inline `data:application/json,…`
  // URIs. Don't hand these to fetch() — Node's fetch treats `#` as a URL
  // fragment delimiter and silently truncates the body, which trips on
  // common cases like `"name":"foo #2"`.
  if (resolvedUri.startsWith("data:")) {
    return parseDataUriJson(resolvedUri)
  }

  // Some metadata CDNs (Arweave gateway via CDN77) block bare server-side
  // fetches and serve an HTML error page. A standard browser UA + JSON
  // accept header gets through.
  const headers = {
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  }

  // For non-IPFS URIs (https, ar://, etc.) keep the single-shot path.
  const cid = extractCid(resolvedUri)
  if (!cid) {
    try {
      const res = await fetch(resolvedUri, {
        signal: AbortSignal.timeout(10_000),
        headers,
        cache: "no-store",
      })
      if (!res.ok) return null
      const contentType = res.headers.get("content-type") ?? ""
      if (!contentType.includes("json") && !contentType.includes("text/plain")) {
        return null
      }
      return await res.json()
    } catch {
      return null
    }
  }

  // IPFS URI — try each gateway in turn so one slow/timed-out gateway doesn't
  // result in `metadata: null` getting cached for 24h.
  try {
    const res = await fetchFromIpfs(cid, { headers, cache: "no-store" })
    const contentType = res.headers.get("content-type") ?? ""
    if (!contentType.includes("json") && !contentType.includes("text/plain")) {
      return null
    }
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Parse a `data:` URI containing JSON metadata. Handles the common encodings:
 *   data:application/json,{...}
 *   data:application/json;utf8,{...}        ← Foundation's zorb contract
 *   data:application/json;charset=utf-8,{...}
 *   data:application/json;base64,<b64>
 * Body content is URL-decoded for the non-base64 forms.
 */
function parseDataUriJson(
  uri: string,
): { name?: string; description?: string; image?: string } | null {
  const comma = uri.indexOf(",")
  if (comma < 0) return null
  const meta = uri.slice(5, comma) // strip "data:"
  const body = uri.slice(comma + 1)
  const isBase64 = /;\s*base64\b/i.test(meta)
  try {
    const decoded = isBase64
      ? Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body)
    return JSON.parse(decoded)
  } catch {
    // Some renderers emit unencoded JSON containing `%` characters that
    // decodeURIComponent rejects. Fall back to the raw body.
    if (!isBase64) {
      try {
        return JSON.parse(body)
      } catch {
        return null
      }
    }
    return null
  }
}
