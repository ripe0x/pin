/**
 * Artist portfolio data layer.
 *
 * Fetches all artist data from on-chain sources via RPC — no indexer dependency.
 * Used by both the artist micro-site page and the preserve flow.
 */
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { normalize } from "viem/ens"
import { discoverArtistTokens, type DiscoveredToken } from "./onchain-discovery"
import { ipfsToHttp } from "@pin/shared"

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
  const [identity, tokens] = await Promise.all([
    getArtistIdentity(address),
    discoverArtistTokens(address),
  ])

  return {
    identity,
    tokens,
    totalWorks: tokens.length,
  }
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
  }
}
