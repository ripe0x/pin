/**
 * Discover an artist's tokens on Manifold Creator Core contracts.
 *
 * The Manifold Client SDK is product-first (it requires an instance ID up
 * front) and there's no documented API to enumerate an artist's contracts by
 * wallet, so we hybridise:
 *
 *   1. Etherscan `account.txlist` (+ `txlistinternal` for Studio deploys
 *      via Manifold's CREATE2 factory) → every contract address the wallet
 *      deployed, direct or via factory.
 *   2. Multicall `supportsInterface(0x28f10a21)` — the `_CREATOR_CORE_V1`
 *      marker baked into every Manifold Creator Core (ERC-721 and ERC-1155
 *      alike). Indeterminate failures get retried individually.
 *   3. Per surviving Manifold contract, Alchemy's NFT API
 *      `getNFTsForContract` returns every minted token with metadata and
 *      CDN-hosted images in one call — handles ERC-721 / ERC-1155 / 1155
 *      `{id}` substitution / burn detection / IPFS gateway fallbacks
 *      transparently. Replaces what used to be hundreds of per-token RPC
 *      calls + IPFS gateway round-trips.
 */
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem"
import { mainnet } from "viem/chains"
import { extractCid, ipfsToHttp } from "@pin/shared"
import type { DiscoveredToken } from "./onchain-discovery"

// Marker every Manifold Creator Core (V1+) returns true for. From
// CreatorCore.sol: `bytes4 private constant _CREATOR_CORE_V1 = 0x28f10a21`.
const CREATOR_CORE_V1_INTERFACE = "0x28f10a21" as const
const ERC721_INTERFACE = "0x80ac58cd" as const
const ERC1155_INTERFACE = "0xd9b67a26" as const

const ERC165_ABI = [
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ type: "bool" }],
  },
] as const

// Just the `name()` getter — used to label a contract in the gallery. The
// per-token reads (`tokenURI`, `ownerOf`, `uri`) are gone now that Alchemy's
// NFT API enumerates tokens with metadata in one call.
const NAME_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const

// Etherscan V2 multichain API (V1 was deprecated Apr 2025). Free tier returns
// up to 10,000 txs per page; one call covers almost every artist. Paginate
// only if/when this becomes a real limit.
const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api"
const MAINNET_CHAIN_ID = 1

// Known Manifold factory/proxy contracts — when an artist deploys via Studio,
// they sign a tx whose `to` is one of these and the new Creator Core is
// CREATE2'd inside the tx. Etherscan's `txlist` won't surface those as
// contract creations under the artist, so we resolve them via per-tx
// `txlistinternal` lookups. Add new addresses here as they're discovered.
const MANIFOLD_FACTORIES: ReadonlySet<string> = new Set([
  "0xf3cd1e9326d1965935b287b1ee75c7183359a88a",
])

// In-memory cache keyed by lowercase address. Etherscan rate limits hard at
// 5 req/s on the free tier, and an artist's deployed-contract list barely
// changes minute-to-minute.
const CONTRACT_LIST_TTL_MS = 10 * 60 * 1000
const contractListCache = new Map<
  string,
  { at: number; contracts: Address[] }
>()

function getClient(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ??
        "https://eth.llamarpc.com",
    ),
  })
}

export async function discoverManifoldTokens(
  artistAddress: string,
): Promise<DiscoveredToken[]> {
  const apiKey = process.env.ETHERSCAN_API_KEY
  if (!apiKey) {
    // Soft-fail: artist gallery still loads with Foundation tokens; absence of
    // a key just means no Manifold work shows up.
    return []
  }

  const artist = artistAddress.toLowerCase() as Address
  const client = getClient()

  const deployed = await listDeployedContracts(artist, apiKey)
  if (deployed.length === 0) return []

  const manifoldContracts = await filterManifoldCreatorCores(client, deployed)
  if (manifoldContracts.length === 0) return []

  // Run per-contract token discovery in parallel — most artists have ≤5
  // Manifold contracts so unbounded parallelism is fine here.
  const perContract = await Promise.all(
    manifoldContracts.map((c) => enumerateTokensViaAlchemyNft(c, artist)),
  )
  return perContract.flat()
}

// ── Etherscan: contracts deployed by this wallet ─────────────────────────────

async function listDeployedContracts(
  artist: Address,
  apiKey: string,
): Promise<Address[]> {
  const cached = contractListCache.get(artist)
  if (cached && Date.now() - cached.at < CONTRACT_LIST_TTL_MS) {
    return cached.contracts
  }

  const url =
    `${ETHERSCAN_BASE}?chainid=${MAINNET_CHAIN_ID}` +
    `&module=account&action=txlist&address=${artist}` +
    `&startblock=0&endblock=99999999&sort=asc&apikey=${apiKey}`

  // Direct deploys (artist signed a tx with `to == ""`) are extracted in one
  // pass; the same pass also collects tx hashes whose `to` is a known Manifold
  // factory, since those are Studio deploys where the new Creator Core is
  // CREATE2'd inside the tx.
  const direct: Address[] = []
  const factoryDeployTxs: string[] = []
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return []
    const json = (await res.json()) as {
      status: string
      message: string
      result:
        | Array<{
            hash: string
            to: string
            contractAddress: string
            isError: string
          }>
        | string
    }
    if (json.status !== "1" || !Array.isArray(json.result)) return []
    for (const tx of json.result) {
      if (tx.isError !== "0") continue
      if (tx.to === "" && tx.contractAddress) {
        direct.push(tx.contractAddress as Address)
      } else if (tx.to && MANIFOLD_FACTORIES.has(tx.to.toLowerCase())) {
        factoryDeployTxs.push(tx.hash)
      }
    }
  } catch {
    return []
  }

  const factoryDeployed = await resolveFactoryDeploys(
    factoryDeployTxs,
    apiKey,
  )

  // Dedupe — the same address shouldn't appear in both lists, but be safe.
  const seen = new Set<string>()
  const result: Address[] = []
  for (const addr of [...direct, ...factoryDeployed]) {
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(addr)
  }

  contractListCache.set(artist, { at: Date.now(), contracts: result })
  return result
}

/**
 * For each artist tx that called a known Manifold factory, fetch the internal
 * trace and pull the CREATE/CREATE2 result. Calls are spaced to stay under
 * Etherscan's free-tier rate limit (3 req/s); artists rarely have more than
 * a handful of factory deploys, so the added latency is small.
 */
async function resolveFactoryDeploys(
  txHashes: string[],
  apiKey: string,
): Promise<Address[]> {
  if (txHashes.length === 0) return []

  const out: Address[] = []
  for (let i = 0; i < txHashes.length; i++) {
    if (i > 0) await sleep(350) // ~3 req/s ceiling on Etherscan free tier
    const hash = txHashes[i]
    const result = await fetchInternalCreates(hash, apiKey)
    out.push(...result)
  }
  return out
}

async function fetchInternalCreates(
  txHash: string,
  apiKey: string,
  attempt = 0,
): Promise<Address[]> {
  const url =
    `${ETHERSCAN_BASE}?chainid=${MAINNET_CHAIN_ID}` +
    `&module=account&action=txlistinternal&txhash=${txHash}` +
    `&apikey=${apiKey}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return []
    const json = (await res.json()) as {
      status: string
      message?: string
      result:
        | Array<{
            type: string
            contractAddress: string
            isError: string
          }>
        | string
    }
    // Etherscan returns status "0" + a string `result` like "Max calls per sec
    // rate limit reached (3/sec)" when throttled. Back off and retry once.
    if (
      json.status !== "1" &&
      typeof json.result === "string" &&
      /rate limit/i.test(json.result) &&
      attempt < 2
    ) {
      await sleep(800)
      return fetchInternalCreates(txHash, apiKey, attempt + 1)
    }
    if (json.status !== "1" || !Array.isArray(json.result)) return []
    const out: Address[] = []
    for (const itx of json.result) {
      if (itx.isError !== "0") continue
      if (itx.type !== "create" && itx.type !== "create2") continue
      if (!itx.contractAddress) continue
      out.push(itx.contractAddress as Address)
    }
    return out
  } catch {
    return []
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Multicall supportsInterface to keep only Manifold Creator Cores ─────────

type ManifoldContract = {
  address: Address
  is721: boolean
  is1155: boolean
  name: string | null
}

async function filterManifoldCreatorCores(
  client: PublicClient,
  contracts: Address[],
): Promise<ManifoldContract[]> {
  // First pass: classify every contract via multicall. Anything that comes
  // back with a transient failure on the marker check goes into a retry list
  // and gets re-probed individually below — without this, an unlucky RPC
  // hiccup on the multicall silently drops a real Manifold contract.
  const survivors: Address[] = []
  const survivorFlags: Array<{ is721: boolean; is1155: boolean }> = []
  const indeterminate: Address[] = []

  for (let i = 0; i < contracts.length; i += 50) {
    const batch = contracts.slice(i, i + 50)

    const { kept, keptFlags, retryAddrs } = await classifyBatch(client, batch)
    survivors.push(...kept)
    survivorFlags.push(...keptFlags)
    indeterminate.push(...retryAddrs)
  }

  // Retry indeterminate contracts one-by-one (still via multicall, just with
  // batch size 1 so a single failure doesn't poison neighbours).
  for (const addr of indeterminate) {
    const { kept, keptFlags } = await classifyBatch(client, [addr])
    survivors.push(...kept)
    survivorFlags.push(...keptFlags)
  }

  if (survivors.length === 0) return []

  // Pick up contract names in one final multicall — failures here are fine
  // (some Creator Cores don't expose `name()`); we just fall back to null.
  const nameCalls = survivors.map((address) => ({
    address,
    abi: NAME_ABI,
    functionName: "name" as const,
    args: [] as const,
  }))
  const nameResults = await client.multicall({
    contracts: nameCalls,
    allowFailure: true,
  })

  return survivors.map((address, j) => ({
    address,
    is721: survivorFlags[j].is721,
    is1155: survivorFlags[j].is1155,
    name:
      nameResults[j].status === "success"
        ? (nameResults[j].result as string)
        : null,
  }))
}

async function classifyBatch(
  client: PublicClient,
  batch: Address[],
): Promise<{
  kept: Address[]
  keptFlags: Array<{ is721: boolean; is1155: boolean }>
  retryAddrs: Address[]
}> {
  const calls = batch.flatMap((address) => [
    {
      address,
      abi: ERC165_ABI,
      functionName: "supportsInterface" as const,
      args: [CREATOR_CORE_V1_INTERFACE] as const,
    },
    {
      address,
      abi: ERC165_ABI,
      functionName: "supportsInterface" as const,
      args: [ERC721_INTERFACE] as const,
    },
    {
      address,
      abi: ERC165_ABI,
      functionName: "supportsInterface" as const,
      args: [ERC1155_INTERFACE] as const,
    },
  ])

  const results = await client.multicall({
    contracts: calls,
    allowFailure: true,
  })

  const kept: Address[] = []
  const keptFlags: Array<{ is721: boolean; is1155: boolean }> = []
  const retryAddrs: Address[] = []

  batch.forEach((address, j) => {
    const isManifold = results[j * 3]
    const is721 = results[j * 3 + 1]
    const is1155 = results[j * 3 + 2]

    // Any failure on the marker call is indeterminate — retry. (A real
    // non-Manifold contract returns success+false; only RPC errors yield
    // status: "failure".) Skip retries for batch-of-one to avoid loops.
    const markerFailed = isManifold.status !== "success"
    if (markerFailed) {
      if (batch.length > 1) retryAddrs.push(address)
      return
    }
    if (isManifold.result !== true) return

    const flag721 = is721.status === "success" && is721.result === true
    const flag1155 = is1155.status === "success" && is1155.result === true
    if (!flag721 && !flag1155) return

    kept.push(address)
    keptFlags.push({ is721: flag721, is1155: flag1155 })
  })

  return { kept, keptFlags, retryAddrs }
}

// ── Per-contract token discovery (Alchemy NFT API) ──────────────────────────

/**
 * Enumerate every token on a Manifold Creator Core via Alchemy's NFT API.
 *
 * Replaces the old per-contract pipeline (Transfer-from-0x0 log scan + per-token
 * tokenURI multicall + IPFS metadata fetch) with one call per contract that
 * returns tokens AND pre-fetched metadata AND CDN-hosted images. Handles
 * ERC-721 / ERC-1155 transparently and the `{id}` substitution for 1155.
 */
async function enumerateTokensViaAlchemyNft(
  contract: ManifoldContract,
  artist: Address,
): Promise<DiscoveredToken[]> {
  const apiKey = process.env.ALCHEMY_API_KEY
  if (!apiKey) return []

  const tokens: DiscoveredToken[] = []
  let pageKey: string | undefined

  do {
    const url = new URL(
      `https://eth-mainnet.g.alchemy.com/nft/v3/${apiKey}/getNFTsForContract`,
    )
    url.searchParams.set("contractAddress", contract.address)
    url.searchParams.set("withMetadata", "true")
    url.searchParams.set("limit", "100")
    if (pageKey) url.searchParams.set("pageKey", pageKey)

    let json: AlchemyGetNFTsForContractResponse
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) break
      json = (await res.json()) as AlchemyGetNFTsForContractResponse
    } catch {
      break
    }

    for (const nft of json.nfts ?? []) {
      tokens.push(mapAlchemyNftToDiscovered(nft, contract, artist))
    }

    pageKey = json.pageKey
  } while (pageKey)

  // Alchemy occasionally returns a token with no `name` / `image` even though
  // the underlying tokenURI resolves fine — this is cache state, not a
  // permanent gap. For each such token, fetch the metadata directly from
  // IPFS/Arweave/etc as a one-shot rescue. Bounded concurrency keeps us from
  // hammering gateways when a contract has many incomplete entries.
  await enrichIncompleteTokens(tokens)

  return tokens
}

const FALLBACK_CONCURRENCY = 5

async function enrichIncompleteTokens(tokens: DiscoveredToken[]): Promise<void> {
  const incomplete = tokens.filter(needsFallback)
  if (incomplete.length === 0) return

  for (let i = 0; i < incomplete.length; i += FALLBACK_CONCURRENCY) {
    const batch = incomplete.slice(i, i + FALLBACK_CONCURRENCY)
    await Promise.all(batch.map(rescueFromTokenUri))
  }
}

function needsFallback(t: DiscoveredToken): boolean {
  // We only attempt fallback if the tokenURI is known — otherwise there's
  // nothing to fetch. "Incomplete" = no display name AND no image.
  if (!t.tokenUri) return false
  const name = t.metadata?.name
  const hasName = typeof name === "string" && name.trim().length > 0
  const hasImage = !!t.mediaHttpUrl
  return !hasName || !hasImage
}

async function rescueFromTokenUri(t: DiscoveredToken): Promise<void> {
  if (!t.tokenUri) return
  try {
    const httpUrl = ipfsToHttp(t.tokenUri)
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return
    const meta = (await res.json()) as {
      name?: string
      description?: string
      image?: string
      image_url?: string
      animation_url?: string
    }

    // Mutate in place — these tokens are already in the array we returned to
    // the caller. Only fill blanks; don't overwrite anything Alchemy gave us.
    const image = meta.image ?? meta.image_url ?? null
    const existingMeta = t.metadata ?? {}
    t.metadata = {
      name: existingMeta.name ?? meta.name,
      description: existingMeta.description ?? meta.description,
      image: existingMeta.image ?? image ?? undefined,
    }
    if (!t.mediaHttpUrl && image) {
      t.mediaHttpUrl = ipfsToHttp(image)
      if (!t.mediaCid) t.mediaCid = extractCid(image)
    }
  } catch {
    // Fallback is best-effort — leave the original (incomplete) record alone.
  }
}

function mapAlchemyNftToDiscovered(
  nft: AlchemyNft,
  contract: ManifoldContract,
  artist: Address,
): DiscoveredToken {
  // Prefer the cleaned `tokenUri` Alchemy normalizes; fall back to `raw` for
  // contracts where Alchemy hasn't post-processed it yet.
  const tokenUri = nft.tokenUri ?? nft.raw?.tokenUri ?? null
  const rawImage = nft.raw?.metadata?.image ?? null
  const name = nft.name ?? nft.raw?.metadata?.name
  const description = nft.description ?? nft.raw?.metadata?.description

  // Alchemy's `image.cachedUrl` is a CDN-hosted thumbnail that doesn't depend
  // on IPFS gateway availability. Fall through to original / IPFS resolution
  // if the cache is empty.
  const mediaHttpUrl =
    nft.image?.cachedUrl ||
    nft.image?.originalUrl ||
    (rawImage ? ipfsToHttp(rawImage) : null)

  return {
    tokenId: nft.tokenId,
    contract: contract.address,
    creator: artist,
    tokenUri,
    metadataCid: tokenUri ? extractCid(tokenUri) : null,
    mediaCid: rawImage ? extractCid(rawImage) : null,
    metadata:
      name || description || rawImage
        ? {
            name,
            description,
            image: rawImage ?? undefined,
          }
        : null,
    mediaHttpUrl,
    collectionName: contract.name,
  }
}

// Subset of the Alchemy NFT API v3 response we actually consume — see
// https://www.alchemy.com/docs/reference/getnftsforcontract-v3
type AlchemyGetNFTsForContractResponse = {
  nfts?: AlchemyNft[]
  pageKey?: string
}

type AlchemyNft = {
  tokenId: string
  tokenType?: "ERC721" | "ERC1155" | "UNKNOWN" | "NOT_A_CONTRACT"
  name?: string
  description?: string
  tokenUri?: string
  image?: {
    cachedUrl?: string
    thumbnailUrl?: string
    pngUrl?: string
    originalUrl?: string
    contentType?: string
    size?: number
  }
  raw?: {
    tokenUri?: string
    metadata?: {
      name?: string
      description?: string
      image?: string
      [key: string]: unknown
    }
  }
}
