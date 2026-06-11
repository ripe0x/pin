/**
 * Artist portfolio data layer.
 *
 * Fetches all artist data from on-chain sources via RPC — no indexer dependency.
 * Used by both the artist micro-site page and the preserve flow.
 */
import { unstable_cache } from "next/cache"
import { createPublicClient, type Address } from "viem"
import { mainnet } from "viem/chains"
import { normalize } from "viem/ens"
import { pgCache } from "./pg-cache"
import { loggingFallbackTransport } from "./rpc-log"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import {
  discoverArtistTokens,
  resolveTokenMetadataDirect,
  type DiscoveredToken,
} from "./onchain-discovery"
import {
  readAddressByEnsName,
  readEnsIdentity,
  writeEnsIdentity,
} from "./ens-identity-store"
import {
  getCachedTokenRefs,
  getCachedEnrichedPage,
  EnrichmentEmpty,
} from "./artist-cache"
import { getArtistSovereignAuctionMap, type SovereignAuctionLite } from "./auctions"
import { getMuriUriCounts } from "./reads"
import { extractCid, ipfsToHttp } from "@pin/shared"

// Module-level singleton used for ENS lookups + a multicall in
// `enrichWithBuyPrices`. Route is unattributed (passed as undefined)
// because this client is shared across many call paths; if a specific
// fanout becomes a hot spot in `rpc_events`, refactor that call site
// to use its own per-route client.
const client = createPublicClient({
  chain: mainnet,
  transport: loggingFallbackTransport(undefined),
})

/**
 * Resolve an ENS name to an Ethereum address.
 *
 * Read path is the persistent `ens_identities` table first — every
 * reverse-resolved row `(address, ens_name)` is also a forward index for
 * free, so any name we've ever resolved (for any artist page, activity-
 * feed enrichment, /delist preview, etc.) serves out of pg with zero
 * RPC. Misses fall through to a live `getEnsAddress` call; on success we
 * persist the row so the next forward + reverse hit both stay warm.
 *
 * Returns null if the name doesn't resolve.
 */
export async function resolveEnsAddress(
  ensName: string,
): Promise<Address | null> {
  const indexed = await readAddressByEnsName(ensName)
  if (indexed) return indexed as Address
  try {
    const address = await client.getEnsAddress({ name: normalize(ensName) })
    if (address) {
      // Persist forward → reverse mirror. Avatar resolution is
      // deferred to the next `getArtistIdentity` call for this
      // address; we store null here rather than make a second RPC
      // round-trip on every forward lookup.
      writeEnsIdentity(address, { ensName, avatarUrl: null })
    }
    return address ?? null
  } catch {
    return null
  }
}

/**
 * Read the `url` text record from the artist's ENS name. Returns null if the
 * artist has no ENS name or no `url` record set.
 *
 * Cached for 24h. Unlike ENS name/avatar (which get the permanent
 * `ens_identities` table treatment because they change rarely), `url` text
 * records DO change with some regularity — artists update their site URL
 * when they move hosting. The TTL strikes the balance between "no RPC on
 * every artist-page view" and "stale within a day."
 */
export async function getEnsUrl(address: Address): Promise<string | null> {
  const lower = address.toLowerCase()
  return pgCache(`ens-url:${lower}`, 60 * 60 * 24, async () => {
    try {
      const id = await getArtistIdentity(lower)
      if (!id.ensName) return null
      const url = await client.getEnsText({
        name: normalize(id.ensName),
        key: "url",
      })
      return url ?? null
    } catch {
      return null
    }
  })
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
export const resolveEnsNameCached = unstable_cache(
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
  // Single read path for all display-name lookups: route through the
  // permanently-indexed `ens_identities` table via `getArtistIdentity`. The
  // first sight of an address resolves it live (EFP / ENS RPC) and persists;
  // every subsequent call is a pg point lookup.
  const id = await getArtistIdentity(address)
  return id.displayName
}

/**
 * Resolve display names for many addresses in parallel.
 * Deduplicates per-call. Every input address gets a returned value.
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

// ─── Off-RPC ENS via EFP (api.ethfollow.xyz) ───────────────────────────────
//
// The Ethereum Follow Protocol's profile API returns reverse-resolved ENS
// (name + avatar) for an address in a single HTTPS call — same data the
// `getEnsName` + `getEnsAvatar` RPC pair would produce, but with zero RPC
// from our side. We use it as the primary resolver and fall back to the
// RPC path on API failure / timeout, so an outage at api.ethfollow.xyz
// degrades to the previous (slower, RPC-burning) behavior rather than
// breaking identity rendering.
//
// Kill switch: `EFP_DISABLED=1` skips EFP entirely and goes straight to RPC.

const EFP_BASE_URL = "https://api.ethfollow.xyz/api/v1"
const EFP_TIMEOUT_MS = 2_500
const EFP_DISABLED = process.env.EFP_DISABLED === "1"

type EfpEnsRecord = { name: string | null; avatar: string | null }

async function fetchEfpEnsRecord(
  lowerAddress: string,
): Promise<EfpEnsRecord | null> {
  if (EFP_DISABLED) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), EFP_TIMEOUT_MS)
  try {
    const res = await fetch(
      `${EFP_BASE_URL}/users/${lowerAddress}/ens`,
      { signal: ctrl.signal },
    )
    if (!res.ok) return null
    const json = (await res.json()) as {
      ens?: { name?: string | null; avatar?: string | null } | null
    }
    return {
      name: json.ens?.name ?? null,
      avatar: json.ens?.avatar ?? null,
    }
  } catch {
    // Timeout / network / parse error — caller falls back to RPC.
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 24h-cached EFP record. Stores both successful responses (including the
 * legitimate "no ENS" answer of `{ name: null, avatar: null }`) and
 * failures (cached as null). On null, callers fall through to RPC — so a
 * sustained EFP outage means RPC is used for affected addresses for up to
 * 24h, identical to the pre-EFP behavior.
 */
export const resolveEfpEnsCached = unstable_cache(
  async (lowerAddress: string): Promise<EfpEnsRecord | null> => {
    return pgCache(`efp-ens:${lowerAddress}`, 60 * 60 * 24, async () => {
      return fetchEfpEnsRecord(lowerAddress)
    })
  },
  ["efp-ens"],
  { revalidate: 60 * 60 * 24, tags: ["ens"] },
)

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
 * Resolve an artist's identity (ENS name + avatar).
 *
 * Read path is a single point lookup against the persistent
 * `ens_identities` table — no TTL, no upstream call. Rows are written
 * once on first sight and live forever. When the row is missing we fall
 * through to live resolution via EFP (HTTPS) with an ENS RPC fallback,
 * then persist the result so the next read is a pure pg hit.
 *
 * Refresh: the stored row never expires on a timer. When a user updates
 * their ENS record their stored display name goes stale; surface a
 * manual invalidation route if/when that becomes a real complaint.
 */
export async function getArtistIdentity(
  address: string,
): Promise<ArtistIdentity> {
  const addr = address as Address
  const lower = address.toLowerCase()

  const stored = await readEnsIdentity(lower)
  if (stored) {
    const displayName = stored.ensName ?? truncateAddress(address)
    return {
      address: addr,
      ensName: stored.ensName,
      displayName,
      avatarUrl: stored.avatarUrl,
    }
  }

  const resolved = await resolveEnsIdentityLive(lower)
  writeEnsIdentity(lower, {
    ensName: resolved.ensName,
    avatarUrl: resolved.avatarUrl,
  })
  const displayName = resolved.ensName ?? truncateAddress(address)
  return {
    address: addr,
    ensName: resolved.ensName,
    displayName,
    avatarUrl: resolved.avatarUrl,
  }
}

/**
 * Live ENS resolution (EFP HTTPS first, ENS RPC fallback). Used internally
 * by `getArtistIdentity` for the cold-path (row missing from
 * `ens_identities`); the resolved value is then persisted so subsequent
 * reads stay on the pg point-lookup path.
 */
async function resolveEnsIdentityLive(
  lowerAddress: string,
): Promise<{ ensName: string | null; avatarUrl: string | null }> {
  const efp = await resolveEfpEnsCached(lowerAddress)
  if (efp !== null && efp.name) {
    return { ensName: efp.name, avatarUrl: efp.avatar }
  }
  // EFP unreachable OR returned a record with no name. EFP's coverage is
  // its social graph, not all of ENS — a name-less EFP record cannot
  // conclude "no reverse record" (seen in prod: djkero.eth reverse-
  // resolves via ENS RPC while EFP returns name:null, which permanently
  // persisted a truncated-address identity). Check the RPC before
  // persisting anything.
  const [ensName, avatarUrl] = await Promise.all([
    resolveEnsNameCached(lowerAddress),
    resolveEnsAvatarCached(lowerAddress),
  ])
  return { ensName, avatarUrl }
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
    // Narrow worker-side platform tags ("fnd-shared", "fnd-collection",
    // "srv2-shared") to the canonical PlatformId used by PlatformChip.
    platform: normalizePlatform(token.platform),
  }
}

function normalizePlatform(p: string): import("./platforms/types").PlatformId | undefined {
  if (p === "fnd-shared" || p === "fnd-collection" || p === "foundation") return "foundation"
  if (p === "srv2-shared" || p === "superrareV2") return "superrareV2"
  if (p === "tl" || p === "transient") return "transient"
  if (p === "mint") return "mint"
  if (p === "manifold") return "manifold"
  if (p === "sovereign") return "sovereign"
  return undefined
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
  /**
   * Active Sovereign auction on the artist's house, or null. Wei amounts
   * and timestamps as decimal strings (JSON can't carry bigint).
   */
  auction: SovereignAuctionLite | null
  /**
   * Artist fallback-URI count if the token is preserved on-chain via MURI,
   * else null. Drives the gallery-tile MURI badge. Postgres-only.
   */
  muriUriCount: number | null
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

  const [enriched, prices, auctionMap, muriCounts] = await Promise.all([
    // `getCachedEnrichedPage` throws `EnrichmentEmpty` when every token
    // in the slice enriches to null (transient RPC/IPFS hiccup, not a
    // real empty gallery) — the throw stops `unstable_cache` from
    // persisting `[]` for the full 24h TTL. Render the page empty for
    // this request; the next visitor's render retries from cold.
    getCachedEnrichedPage(slice).catch((err) => {
      if (err instanceof EnrichmentEmpty) return [] as DiscoveredToken[]
      throw err
    }),
    fetchBuyPrices(slice),
    getArtistSovereignAuctionMap(artistAddress).catch(
      (): Record<string, SovereignAuctionLite> => ({}),
    ),
    // Postgres-only MURI preservation counts for this page (no RPC).
    getMuriUriCounts(slice.map((r) => ({ contract: r.contract, tokenId: r.tokenId }))).catch(
      (): Map<string, number> => new Map(),
    ),
  ])

  const tokens: GalleryItem[] = enriched.map((token) => {
    const display = tokenToDisplayData(token)
    const key = `${token.contract.toLowerCase()}:${token.tokenId}`
    return {
      ...display,
      buyPrice: prices.get(key) ?? null,
      auction: auctionMap[key] ?? null,
      muriUriCount: muriCounts.get(key) ?? null,
    }
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
