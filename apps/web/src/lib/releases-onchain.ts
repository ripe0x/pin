import "server-only"
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { releaseAbi, releaseFactoryAbi } from "@pin/abi"
import { pgCache } from "./pg-cache"
import {
  GateMode,
  ReleaseStatus,
  type ReleaseView,
  ipfsToHttp,
} from "./releases"

/**
 * Server-only cached reads for the Releases protocol. Pre-indexer phase:
 * the web reads the chain directly, but every read is short-TTL cached
 * (pgCache shares across serverless sandboxes) and multicalled, so page
 * traffic never fans out to per-render RPC. Once the Ponder factory()
 * wiring lands post-deploy, list/history reads move to Postgres and this
 * file shrinks to the live-freshness reads.
 */

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"

function getClient() {
  if (FORK_MODE) {
    const url =
      process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545"
    // mainnet chain object: the fork preserves Multicall3.
    return createPublicClient({ chain: mainnet, transport: http(url) })
  }
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) {
    return createPublicClient({ chain: mainnet, transport: http(explicit) })
  }
  const key = process.env.ALCHEMY_API_KEY
  const url =
    key && !key.startsWith("set-")
      ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
      : "https://eth.drpc.org"
  return createPublicClient({ chain: mainnet, transport: http(url) })
}

const lc = (a: string) => a.toLowerCase()

type RawSummary = {
  name: string
  symbol: string
  artist: Address
  payout: Address
  price: bigint
  surfaceFee: bigint
  startTime: bigint
  endTime: bigint
  maxSupply: bigint
  gateToken: Address
  gateMode: number
  status: number
  totalMinted: bigint
  totalSupply: bigint
  closed: boolean
  metadataFrozen: boolean
  uri: string
  uriPerToken: boolean
  renderer: Address
  royaltyReceiver: Address
  royaltyBps: bigint
}

function toView(
  address: Address,
  s: RawSummary,
  owner: Address,
  artistBalance: bigint,
): ReleaseView {
  return {
    address,
    name: s.name,
    symbol: s.symbol,
    artist: s.artist,
    owner,
    payout: s.payout,
    price: s.price.toString(),
    surfaceFee: s.surfaceFee.toString(),
    startTime: s.startTime.toString(),
    endTime: s.endTime.toString(),
    maxSupply: s.maxSupply.toString(),
    gateToken: s.gateToken,
    gateMode: Number(s.gateMode) as GateMode,
    status: Number(s.status) as ReleaseStatus,
    totalMinted: s.totalMinted.toString(),
    totalSupply: s.totalSupply.toString(),
    closed: s.closed,
    metadataFrozen: s.metadataFrozen,
    uri: s.uri,
    uriPerToken: s.uriPerToken,
    renderer: s.renderer,
    royaltyReceiver: s.royaltyReceiver,
    royaltyBps: Number(s.royaltyBps),
    artistBalance: artistBalance.toString(),
  }
}

/** One release: summary() + owner + accrued balance. Short TTL. */
export async function getRelease(
  address: Address,
): Promise<ReleaseView | null> {
  return pgCache(`release:${lc(address)}`, 20, async () => {
    const client = getClient()
    const base = { address, abi: releaseAbi } as const
    try {
      const [summary, owner, artistBalance] = await client.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: "summary" },
          { ...base, functionName: "owner" },
          { ...base, functionName: "artistBalance" },
        ],
      })
      return toView(
        address,
        summary as RawSummary,
        owner as Address,
        artistBalance as bigint,
      )
    } catch {
      return null
    }
  })
}

/** The factory's current per-token surface fee (for the create form). */
export async function getFactorySurfaceFee(
  factory: Address,
): Promise<string | null> {
  return pgCache(`release-factory-fee:${lc(factory)}`, 300, async () => {
    try {
      const fee = await getClient().readContract({
        address: factory,
        abi: releaseFactoryAbi,
        functionName: "surfaceFee",
      })
      return (fee as bigint).toString()
    } catch {
      return null
    }
  })
}

/** Most recent releases from the factory registry, newest first. */
export async function getRecentReleases(
  factory: Address,
  limit = 12,
): Promise<ReleaseView[]> {
  return pgCache(`release-recent:${lc(factory)}:${limit}`, 60, async () => {
    const client = getClient()
    try {
      const total = (await client.readContract({
        address: factory,
        abi: releaseFactoryAbi,
        functionName: "totalReleases",
      })) as bigint
      const n = Number(total)
      if (n === 0) return []
      const count = Math.min(n, limit)
      const indexes = Array.from(
        { length: count },
        (_, i) => BigInt(n - 1 - i),
      )
      const addresses = (await client.multicall({
        allowFailure: false,
        contracts: indexes.map((i) => ({
          address: factory,
          abi: releaseFactoryAbi,
          functionName: "allReleases" as const,
          args: [i] as const,
        })),
      })) as Address[]

      const summaries = await client.multicall({
        allowFailure: true,
        contracts: addresses.flatMap((address) => [
          { address, abi: releaseAbi, functionName: "summary" as const },
          { address, abi: releaseAbi, functionName: "owner" as const },
        ]),
      })

      const out: ReleaseView[] = []
      for (let i = 0; i < addresses.length; i++) {
        const sum = summaries[i * 2]
        const own = summaries[i * 2 + 1]
        if (sum.status !== "success" || own.status !== "success") continue
        out.push(
          toView(
            addresses[i],
            sum.result as RawSummary,
            own.result as Address,
            0n,
          ),
        )
      }
      return out
    } catch {
      return []
    }
  })
}

export type ReleaseTokenView = {
  tokenId: string
  owner: Address | null // null when burned
  tokenURI: string | null
}

/** One token: owner (null = burned) + tokenURI. */
export async function getReleaseToken(
  address: Address,
  tokenId: bigint,
): Promise<ReleaseTokenView | null> {
  return pgCache(
    `release-token:${lc(address)}:${tokenId.toString()}`,
    60,
    async () => {
      const client = getClient()
      const base = { address, abi: releaseAbi } as const
      const [owner, uri] = await client.multicall({
        allowFailure: true,
        contracts: [
          { ...base, functionName: "ownerOf", args: [tokenId] },
          { ...base, functionName: "tokenURI", args: [tokenId] },
        ],
      })
      // A token that was never minted has neither owner nor URI.
      if (owner.status !== "success" && uri.status !== "success") return null
      return {
        tokenId: tokenId.toString(),
        owner: owner.status === "success" ? (owner.result as Address) : null,
        tokenURI: uri.status === "success" ? (uri.result as string) : null,
      }
    },
  )
}

export type ReleaseOwnerEntry = {
  tokenId: string
  owner: Address | null // null when burned
}

/**
 * Recent tokens with owners — ids are sequential from 1, so "history" is
 * the last N ids, no logs needed.
 */
export async function getRecentTokenOwners(
  address: Address,
  totalMinted: bigint,
  limit = 12,
): Promise<ReleaseOwnerEntry[]> {
  const total = Number(totalMinted)
  if (total === 0) return []
  return pgCache(`release-owners:${lc(address)}:${total}`, 30, async () => {
    const client = getClient()
    const count = Math.min(total, limit)
    const ids = Array.from({ length: count }, (_, i) => BigInt(total - i))
    const owners = await client.multicall({
      allowFailure: true, // burned tokens revert ownerOf
      contracts: ids.map((id) => ({
        address,
        abi: releaseAbi,
        functionName: "ownerOf" as const,
        args: [id] as const,
      })),
    })
    return ids.map((id, i) => ({
      tokenId: id.toString(),
      owner:
        owners[i].status === "success"
          ? (owners[i].result as Address)
          : null,
    }))
  })
}

type TokenMetadata = { image: string | null; description: string | null }

/**
 * Resolve the display image from a release's metadata JSON. Long TTL —
 * metadata is artist-frozen territory, and a stale card image is cheap.
 */
export async function getReleaseImage(
  uri: string,
  uriPerToken: boolean,
): Promise<TokenMetadata> {
  if (!uri) return { image: null, description: null }
  const source = uriPerToken ? `${uri}1` : uri
  return pgCache(`release-image:${source}`, 3600, async () => {
    try {
      const res = await fetch(ipfsToHttp(source), {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return { image: null, description: null }
      const json = (await res.json()) as {
        image?: string
        description?: string
      }
      return {
        image: json.image ? ipfsToHttp(json.image) : null,
        description: json.description ?? null,
      }
    } catch {
      return { image: null, description: null }
    }
  })
}
