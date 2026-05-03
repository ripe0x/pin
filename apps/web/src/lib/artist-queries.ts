/**
 * Artist portfolio data layer.
 *
 * Fetches all artist data from on-chain sources via RPC — no indexer dependency.
 * Used by both the artist micro-site page and the preserve flow.
 */
import { unstable_cache } from "next/cache"
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { normalize } from "viem/ens"
import { pgCache } from "./pg-cache"
import { getAlchemyMainnetUrl } from "./alchemy-rpc"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import {
  discoverArtistTokens,
  resolveTokenMetadataDirect,
  type DiscoveredToken,
} from "./onchain-discovery"
import {
  getCachedTokenRefs,
  getCachedEnrichedPage,
} from "./artist-cache"
import { extractCid, ipfsToHttp } from "@pin/shared"

const client = createPublicClient({
  chain: mainnet,
  transport: http(
    getAlchemyMainnetUrl(),
  ),
})

/**
 * Resolve an ENS name to an Ethereum address.
 * Returns null if the name doesn't resolve.
 */
export async function resolveEnsAddress(
  ensName: string,
): Promise<Address | null> {
  try {
    const address = await client.getEnsAddress({ name: normalize(ensName) })
    return address ?? null
  } catch {
    return null
  }
}

export type ArtistIdentity = {
  address: Address
  ensName: string | null
  displayName: string
  avatarUrl: string | null
}

export type ArtistPortfolio = {
  identity: ArtistIdentity
  tokens: DiscoveredToken[]
  totalWorks: number
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * Resolve a display name for one address (ENS if set, else truncated 0x…).
 *
 * Cached per-address for 24h. ENS reverse records change rarely, but every
 * uncached lookup is an `eth_call` to the ENS resolver — so without this we
 * burn a chain read for every (creator, owner, bidder, provenance entry) on
 * every page render. The cache key is the lowercased address.
 *
 * Use `revalidateTag("ens")` to manually flush (e.g. after an ENS update).
 */
const resolveEnsNameCached = unstable_cache(
  async (lowerAddress: string): Promise<string | null> => {
    // L1 (unstable_cache, in-process) wraps L2 (pgCache, shared Postgres)
    // wraps the actual ENS resolver. Same TTL on both layers — the L2
    // hit rate is what saves cold-start fan-out across Netlify sandboxes.
    return pgCache(`ens:${lowerAddress}`, 60 * 60 * 24, async () => {
      try {
        const ensName = await client.getEnsName({
          address: lowerAddress as Address,
        })
        return ensName ?? null
      } catch {
        return null
      }
    })
  },
  ["ens-name"],
  { revalidate: 60 * 60 * 24, tags: ["ens"] },
)

export async function resolveDisplayName(address: string): Promise<string> {
  const lower = address.toLowerCase()
  const ensName = await resolveEnsNameCached(lower)
  return ensName ?? truncateAddress(address)
}

/**
 * Resolve display names for many addresses in parallel.
 * Deduplicates and caches per-call. Always returns a value per input address.
 */
export async function resolveDisplayNames(
  addresses: readonly string[],
): Promise<Map<string, string>> {
  const lower = addresses.map((a) => a.toLowerCase())
  const unique = Array.from(new Set(lower))
  const entries = await Promise.all(
    unique.map(async (a) => [a, await resolveDisplayName(a)] as const),
  )
  return new Map(entries)
}

/**
 * Cached ENS avatar lookup, keyed by address. Uses the cached name as
 * input but is itself address-keyed so future calls hit the L2 directly
 * without re-resolving the name. Same 24h TTL + ens tag as the name
 * cache so a single revalidateTag("ens") flushes both.
 */
const resolveEnsAvatarCached = unstable_cache(
  async (lowerAddress: string): Promise<string | null> => {
    return pgCache(`ens-avatar:${lowerAddress}`, 60 * 60 * 24, async () => {
      const ensName = await resolveEnsNameCached(lowerAddress)
      if (!ensName) return null
      try {
        const avatar = await client.getEnsAvatar({ name: normalize(ensName) })
        return avatar ?? null
      } catch {
        return null
      }
    })
  },
  ["ens-avatar"],
  { revalidate: 60 * 60 * 24, tags: ["ens"] },
)

/**
 * Resolve an artist's identity (ENS name + avatar). Both lookups go
 * through the L1+L2 cache so warm-cache calls collapse to two point
 * lookups instead of two ENS resolver `eth_call`s. Issued in parallel —
 * the avatar cache transparently re-uses the cached name internally.
 */
export async function getArtistIdentity(
  address: string,
): Promise<ArtistIdentity> {
  const addr = address as Address
  const lower = address.toLowerCase()
  const [ensName, avatarUrl] = await Promise.all([
    resolveEnsNameCached(lower),
    resolveEnsAvatarCached(lower),
  ])
  const displayName = ensName ?? `${address.slice(0, 6)}...${address.slice(-4)}`
  return { address: addr, ensName, displayName, avatarUrl }
}

/**
 * Get a full artist portfolio: identity + all works.
 */
export async function getArtistPortfolio(
  address: string,
): Promise<ArtistPortfolio> {
  const [identity, rawTokens] = await Promise.all([
    getArtistIdentity(address),
    discoverArtistTokens(address),
  ])

  const tokens = await enrichMissingMetadata(rawTokens)

  return {
    identity,
    tokens,
    totalWorks: tokens.length,
  }
}

/**
 * Backfill metadata for tokens whose discovery source returned no name/image.
 * Most relevant for ERC1155 tokens where the discovery sometimes can't reach
 * `uri()` (Manifold tokens not yet indexed by Alchemy, etc.). Falls back to a
 * direct on-chain read which tries `tokenURI` then `uri` automatically.
 */
async function enrichMissingMetadata(
  tokens: DiscoveredToken[],
): Promise<DiscoveredToken[]> {
  // Enrich any token that's missing a real name or image. Some upstream
  // sources (Alchemy NFT API) substitute a `#<tokenId>` placeholder for the
  // name when they don't have the real metadata — treat that as missing too.
  const isPlaceholderName = (t: DiscoveredToken) =>
    !t.metadata?.name || t.metadata.name === `#${t.tokenId}`

  const needsEnrichment = tokens
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => isPlaceholderName(t) || !t.mediaHttpUrl)

  if (needsEnrichment.length === 0) return tokens

  const filled = [...tokens]
  await Promise.all(
    needsEnrichment.map(async ({ t, idx }) => {
      const meta = await resolveTokenMetadataDirect(t.contract, t.tokenId)
      if (!meta) return
      // For each field, prefer the existing value only if it's "real". A
      // `#<tokenId>` name is a placeholder, treat as missing.
      const existingNameIsReal =
        t.metadata?.name && t.metadata.name !== `#${t.tokenId}`
      const mergedMeta = {
        name: existingNameIsReal ? t.metadata!.name : meta.name,
        description: t.metadata?.description || meta.description,
        image: t.metadata?.image || meta.image,
      }
      const newMediaUrl =
        t.mediaHttpUrl || (mergedMeta.image ? ipfsToHttp(mergedMeta.image) : null)
      filled[idx] = {
        ...t,
        metadata:
          mergedMeta.name || mergedMeta.description || mergedMeta.image
            ? mergedMeta
            : t.metadata,
        mediaHttpUrl: newMediaUrl,
        mediaCid: mergedMeta.image
          ? t.mediaCid ?? extractCid(mergedMeta.image)
          : t.mediaCid,
      }
    }),
  )
  return filled
}

/**
 * Convert a DiscoveredToken to the shape needed for ArtworkCard display.
 */
export function tokenToDisplayData(token: DiscoveredToken) {
  const imageUrl =
    token.mediaHttpUrl ??
    (token.metadata?.image ? ipfsToHttp(token.metadata.image) : null) ??
    "https://placehold.co/800x1000/F2F2F2/999999?text=NFT"

  return {
    contract: token.contract,
    tokenId: token.tokenId,
    title: token.metadata?.name ?? `#${token.tokenId}`,
    description: token.metadata?.description ?? "",
    imageUrl,
    creator: token.creator,
    metadataCid: token.metadataCid,
    mediaCid: token.mediaCid,
    platform: token.platform,
  }
}

// ── Paginated artist gallery ────────────────────────────────────────────────

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

export type GalleryItem = ReturnType<typeof tokenToDisplayData> & {
  /**
   * Active buy-now listing on `NFTMarket`, or null. Price serialized as a
   * decimal string because JSON can't carry bigint.
   */
  buyPrice: { seller: string; price: string } | null
}

export type GalleryPage = {
  tokens: GalleryItem[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

/**
 * Fetch one page of an artist's gallery: refs (cached), enriched metadata
 * (cached per page), and buy-prices (one multicall per request). Used by
 * both SSR (initial paint) and the paginated API route.
 */
export async function getArtistGalleryPage(
  artistAddress: string,
  page: number,
  pageSize: number,
): Promise<GalleryPage> {
  const refs = await getCachedTokenRefs(artistAddress)
  const total = refs.length
  const start = page * pageSize
  const slice = refs.slice(start, start + pageSize)

  if (slice.length === 0) {
    return { tokens: [], total, page, pageSize, hasMore: false }
  }

  const [enriched, prices] = await Promise.all([
    getCachedEnrichedPage(slice),
    fetchBuyPrices(slice),
  ])

  const tokens: GalleryItem[] = enriched.map((token) => {
    const display = tokenToDisplayData(token)
    const key = `${token.contract.toLowerCase()}:${token.tokenId}`
    return { ...display, buyPrice: prices.get(key) ?? null }
  })

  return {
    tokens,
    total,
    page,
    pageSize,
    hasMore: start + slice.length < total,
  }
}

/**
 * Batched on-chain read of `NFTMarket.getBuyPrice` for a page of tokens.
 * Returns a map keyed by `${contract.toLowerCase()}:${tokenId}` so callers
 * can look up by the same key regardless of result ordering.
 */
async function fetchBuyPrices(
  refs: readonly { contract: Address; tokenId: string }[],
): Promise<Map<string, { seller: string; price: string } | null>> {
  const out = new Map<string, { seller: string; price: string } | null>()

  const calls = refs.map((r) => ({
    address: MARKET_ADDRESS,
    abi: nftMarketAbi,
    functionName: "getBuyPrice" as const,
    args: [r.contract, BigInt(r.tokenId)] as const,
  }))

  type MulticallEntry =
    | { status: "success"; result: unknown }
    | { status: "failure"; error: unknown }

  let results: MulticallEntry[]
  try {
    results = (await client.multicall({
      contracts: calls,
      allowFailure: true,
    })) as MulticallEntry[]
  } catch {
    // If the whole multicall failed, return all-null; the gallery still renders.
    for (const r of refs) {
      out.set(`${r.contract.toLowerCase()}:${r.tokenId}`, null)
    }
    return out
  }

  refs.forEach((r, i) => {
    const key = `${r.contract.toLowerCase()}:${r.tokenId}`
    const result = results[i]
    if (result.status !== "success") {
      out.set(key, null)
      return
    }
    const { seller, price } = result.result as { seller: string; price: bigint }
    if (seller === ZERO_ADDRESS || price === 0n) {
      out.set(key, null)
      return
    }
    out.set(key, { seller, price: price.toString() })
  })

  return out
}
