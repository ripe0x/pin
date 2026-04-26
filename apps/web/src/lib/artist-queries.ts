/**
 * Artist portfolio data layer.
 *
 * Fetches all artist data from on-chain sources via RPC — no indexer dependency.
 * Used by both the artist micro-site page and the preserve flow.
 */
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { normalize } from "viem/ens"
import {
  discoverArtistTokens,
  resolveTokenMetadataDirect,
  type DiscoveredToken,
} from "./onchain-discovery"
import { extractCid, ipfsToHttp } from "@pin/shared"

const client = createPublicClient({
  chain: mainnet,
  transport: http(
    process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ?? "https://eth.llamarpc.com",
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
 */
export async function resolveDisplayName(address: string): Promise<string> {
  try {
    const ensName = await client.getEnsName({ address: address as Address })
    if (ensName) return ensName
  } catch {
    // ignore
  }
  return truncateAddress(address)
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
 * Resolve an artist's identity (ENS name + avatar).
 */
export async function getArtistIdentity(
  address: string,
): Promise<ArtistIdentity> {
  const addr = address as Address
  let ensName: string | null = null
  let avatarUrl: string | null = null

  try {
    ensName = await client.getEnsName({ address: addr })
    if (ensName) {
      avatarUrl = await client.getEnsAvatar({ name: normalize(ensName) })
    }
  } catch {
    // ENS resolution failed — use address as fallback
  }

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
  }
}
