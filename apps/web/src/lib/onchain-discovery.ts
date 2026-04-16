/**
 * On-demand artist token discovery via direct RPC calls.
 *
 * Finds all tokens an artist minted on Foundation — both the shared NFT
 * contract and any per-artist collection contracts deployed via the
 * NFTCollectionFactory.
 *
 * No indexer dependency — works with just an RPC endpoint + IPFS gateways.
 */
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { foundationNftAbi, collectionFactoryAbi, erc721Abi } from "@commonground/abi"
import {
  FOUNDATION_NFT,
  COLLECTION_FACTORY_V1,
  COLLECTION_FACTORY_V2,
  MAINNET_CHAIN_ID,
} from "@commonground/addresses"
import { extractCid, ipfsToHttp } from "@commonground/shared"

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

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ?? "https://eth.llamarpc.com",
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
 * Discover all tokens minted by an artist on Foundation.
 *
 * Scans two sources:
 * 1. The shared FoundationNFT contract (Minted event filtered by creator)
 * 2. Per-artist collection contracts (found via NFTCollectionFactory events)
 */
export async function discoverArtistTokens(
  artistAddress: string,
): Promise<DiscoveredToken[]> {
  const client = getClient()
  const artist = artistAddress.toLowerCase() as Address
  const latestBlock = await client.getBlockNumber()

  // Run shared contract scan and collection factory scan in parallel
  const [sharedTokens, collectionTokens] = await Promise.all([
    discoverSharedContractTokens(client, artist, latestBlock),
    discoverCollectionTokens(client, artist, latestBlock),
  ])

  return [...sharedTokens, ...collectionTokens]
}

// ── Shared contract discovery ────────────────────────────────────────────────

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

async function findArtistCollections(
  client: ReturnType<typeof createPublicClient>,
  artist: Address,
  latestBlock: bigint,
): Promise<CollectionInfo[]> {
  const collections: CollectionInfo[] = []

  // Scan both factory versions for NFTCollectionCreated events
  const nftCollectionEvent = parseAbiItem(
    "event NFTCollectionCreated(address indexed collection, address indexed creator, uint256 indexed version, string name, string symbol, uint256 nonce)",
  )

  const dropCollectionEvent = parseAbiItem(
    "event NFTDropCollectionCreated(address indexed collection, address indexed creator, address indexed approvedMinter, string name, string symbol, string baseURI, bool isRevealed, uint256 maxTokenId, address paymentAddress, uint256 version, uint256 nonce)",
  )

  // Scan V1 and V2 factories in parallel
  const [v1Collections, v1Drops, v2Collections, v2Drops] = await Promise.all([
    getLogs(client, FACTORY_V1, nftCollectionEvent, { creator: artist }, FACTORY_V1_DEPLOY_BLOCK, latestBlock),
    getLogs(client, FACTORY_V1, dropCollectionEvent, { creator: artist }, FACTORY_V1_DEPLOY_BLOCK, latestBlock),
    getLogs(client, FACTORY_V2, nftCollectionEvent, { creator: artist }, FACTORY_V2_DEPLOY_BLOCK, latestBlock),
    getLogs(client, FACTORY_V2, dropCollectionEvent, { creator: artist }, FACTORY_V2_DEPLOY_BLOCK, latestBlock),
  ])

  for (const log of [...v1Collections, ...v2Collections]) {
    const args = (log as { args: { collection: Address; name: string } }).args
    collections.push({ address: args.collection, name: args.name })
  }

  for (const log of [...v1Drops, ...v2Drops]) {
    const args = (log as { args: { collection: Address; name: string } }).args
    collections.push({ address: args.collection, name: args.name })
  }

  return collections
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
  const tokens: DiscoveredToken[] = []

  for (let i = 0; i < tokenIds.length; i += 50) {
    const batchIds = tokenIds.slice(i, i + 50)

    // Batch ownerOf + tokenURI calls together
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

    const metadataPromises = batchIds.map(async (tokenId, j) => {
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
          const httpUrl = ipfsToHttp(tokenUri)
          const res = await fetch(httpUrl, {
            signal: AbortSignal.timeout(10_000),
          })
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
    })

    const batchTokens = await Promise.all(metadataPromises)
    tokens.push(...batchTokens.filter((t): t is DiscoveredToken => t !== null))
  }

  return tokens
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
 * Used by the token detail page when Ponder data is unavailable.
 */
export async function getTokenOnChainData(
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
  const creator = creatorResult ? (creatorResult as string) : null

  // Fetch transfer history
  const latestBlock = await client.getBlockNumber()
  const transferLogs = await getLogs(
    client,
    contract,
    transferEvent,
    { tokenId: id },
    SHARED_DEPLOY_BLOCK,
    latestBlock,
  )

  // Resolve block timestamps for each transfer
  const transfers = await Promise.all(
    transferLogs.map(async (log) => {
      const l = log as {
        args: { from: string; to: string; tokenId: bigint }
        blockNumber: bigint
        transactionHash: string
      }
      let timestamp = 0
      try {
        const block = await client.getBlock({ blockNumber: l.blockNumber })
        timestamp = Number(block.timestamp)
      } catch {
        // timestamp stays 0
      }
      return {
        from: l.args.from,
        to: l.args.to,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        timestamp,
      }
    }),
  )

  return { owner, creator, transfers }
}
