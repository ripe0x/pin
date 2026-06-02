import "server-only"
import { createPublicClient, http, type Address } from "viem"
import { foundry, mainnet } from "viem/chains"
import { pndEditionsAbi, pndEditionsFactoryAbi } from "@pin/abi"
import { pgCache } from "./pg-cache"
import {
  decodeMintMark,
  decodeReleaseConfig,
  type EditionEdge,
  type EditionMintMark,
  type EditionPath,
  type EditionProject,
  type EditionRelease,
  PND_CHAIN_ID,
  ReleaseStatus,
} from "./pnd-editions"

/**
 * Live, cached onchain reads for PND Editions. These are the project's own
 * contracts (no indexer backfill required for the live mint/provenance
 * surfaces). Every function is pgCache-wrapped and batches with multicall, so
 * upstream call volume stays low. Immutable data (mint marks) caches long;
 * live mint state (price/supply/window) caches briefly.
 *
 * Listing/discovery (artist catalogs, feeds) reads Postgres via the worker
 * scanner, not this module.
 */

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"

function getClient() {
  if (FORK_MODE) {
    const url = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545"
    return createPublicClient({ chain: foundry, transport: http(url) })
  }
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return createPublicClient({ chain: mainnet, transport: http(explicit) })
  const key = process.env.ALCHEMY_API_KEY
  const url =
    key && !key.startsWith("set-")
      ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
      : "https://eth.drpc.org"
  return createPublicClient({ chain: mainnet, transport: http(url) })
}

const lc = (a: string) => a.toLowerCase()

/** Project header: identity, owner, counts, mutability. */
export async function getEditionProject(project: Address): Promise<EditionProject | null> {
  return pgCache(`pnd-project:${lc(project)}`, 60, async () => {
    const client = getClient()
    const base = { address: project, abi: pndEditionsAbi } as const
    try {
      const [name, symbol, owner, totalReleases, totalSupply, upgradeable, sealedFlag] =
        await client.multicall({
          allowFailure: false,
          contracts: [
            { ...base, functionName: "name" },
            { ...base, functionName: "symbol" },
            { ...base, functionName: "owner" },
            { ...base, functionName: "totalReleases" },
            { ...base, functionName: "totalSupply" },
            { ...base, functionName: "isUpgradeable" },
            { ...base, functionName: "isSealed" },
          ],
        })
      return {
        address: project,
        name: name as string,
        symbol: symbol as string,
        owner: owner as Address,
        totalReleases: Number(totalReleases),
        totalSupply: totalSupply as bigint,
        isUpgradeable: upgradeable as boolean,
        isSealed: sealedFlag as boolean,
      }
    } catch {
      return null
    }
  })
}

/** One release's full state. Short TTL: this is live mint state. */
export async function getEditionRelease(
  project: Address,
  releaseId: number,
): Promise<EditionRelease | null> {
  return pgCache(`pnd-release:${lc(project)}:${releaseId}`, 20, async () => {
    const client = getClient()
    try {
      const result = (await client.readContract({
        address: project,
        abi: pndEditionsAbi,
        functionName: "release",
        args: [BigInt(releaseId)],
      })) as readonly [Parameters<typeof decodeReleaseConfig>[0], number, bigint]
      const [cfg, status, minted] = result
      return {
        releaseId,
        cfg: decodeReleaseConfig(cfg),
        status: Number(status) as ReleaseStatus,
        minted,
      }
    } catch {
      return null
    }
  })
}

/** All releases in a project (bounded by totalReleases). For the project page. */
export async function getEditionReleases(
  project: Address,
  totalReleases: number,
): Promise<EditionRelease[]> {
  if (totalReleases <= 0) return []
  return pgCache(`pnd-releases:${lc(project)}:${totalReleases}`, 30, async () => {
    const client = getClient()
    const ids = Array.from({ length: totalReleases }, (_, i) => i)
    try {
      const results = await client.multicall({
        allowFailure: true,
        contracts: ids.map((i) => ({
          address: project,
          abi: pndEditionsAbi,
          functionName: "release" as const,
          args: [BigInt(i)] as const,
        })),
      })
      const out: EditionRelease[] = []
      results.forEach((r, i) => {
        if (r.status !== "success") return
        const [cfg, status, minted] = r.result as readonly [
          Parameters<typeof decodeReleaseConfig>[0],
          number,
          bigint,
        ]
        out.push({
          releaseId: i,
          cfg: decodeReleaseConfig(cfg),
          status: Number(status) as ReleaseStatus,
          minted,
        })
      })
      return out
    } catch {
      return []
    }
  })
}

/** Release Graph edges for a release. */
export async function getEditionEdges(
  project: Address,
  releaseId: number,
): Promise<EditionEdge[]> {
  return pgCache(`pnd-edges:${lc(project)}:${releaseId}`, 120, async () => {
    const client = getClient()
    try {
      const edges = (await client.readContract({
        address: project,
        abi: pndEditionsAbi,
        functionName: "edgesOf",
        args: [BigInt(releaseId)],
      })) as ReadonlyArray<{
        edgeType: number
        target: { chainId: bigint; contractAddress: Address; id: bigint; kind: number }
      }>
      return edges.map((e) => ({
        edgeType: Number(e.edgeType),
        target: {
          chainId: Number(e.target.chainId),
          contractAddress: e.target.contractAddress,
          id: e.target.id,
          kind: Number(e.target.kind),
        },
      }))
    } catch {
      return []
    }
  })
}

export type EditionTokenView = {
  tokenId: bigint
  owner: Address | null
  mark: EditionMintMark
  artwork: string
  path: EditionPath
  release: EditionRelease | null
}

/** Everything the token page needs: Mint Mark, art, path, owner. */
export async function getEditionToken(
  project: Address,
  tokenId: bigint,
): Promise<EditionTokenView | null> {
  return pgCache(`pnd-token:${lc(project)}:${tokenId.toString()}`, 60, async () => {
    const client = getClient()
    const base = { address: project, abi: pndEditionsAbi } as const
    try {
      const [markRes, artRes, pathRes, ownerRes] = await client.multicall({
        allowFailure: true,
        contracts: [
          { ...base, functionName: "mintMarkOf", args: [tokenId] },
          { ...base, functionName: "tokenArtwork", args: [tokenId] },
          { ...base, functionName: "pathOf", args: [tokenId] },
          { ...base, functionName: "ownerOf", args: [tokenId] },
        ],
      })
      if (markRes.status !== "success") return null
      const mark = decodeMintMark(
        markRes.result as Parameters<typeof decodeMintMark>[0],
      )
      const release = await getEditionRelease(project, mark.releaseId)
      const tokenArt = artRes.status === "success" ? (artRes.result as string) : ""
      const artwork = tokenArt && tokenArt.length > 0 ? tokenArt : release?.cfg.defaultArtworkURI ?? ""
      const rawPath =
        pathRes.status === "success"
          ? (pathRes.result as {
              pathType: number
              target: { chainId: bigint; contractAddress: Address; id: bigint; kind: number }
              data: `0x${string}`
            })
          : null
      const path: EditionPath = rawPath
        ? {
            pathType: Number(rawPath.pathType),
            target: {
              chainId: Number(rawPath.target.chainId),
              contractAddress: rawPath.target.contractAddress,
              id: rawPath.target.id,
              kind: Number(rawPath.target.kind),
            },
            data: rawPath.data,
          }
        : { pathType: 0, target: { chainId: PND_CHAIN_ID, contractAddress: project, id: 0n, kind: 0 }, data: "0x" as `0x${string}` }
      return {
        tokenId,
        owner: ownerRes.status === "success" ? (ownerRes.result as Address) : null,
        mark,
        artwork,
        path,
        release,
      }
    } catch {
      return null
    }
  })
}

/** Recent projects from the factory, newest first. For the editions landing. */
export async function getRecentProjects(
  factory: Address,
  limit = 8,
): Promise<EditionProject[]> {
  return pgCache(`pnd-recent:${lc(factory)}:${limit}`, 60, async () => {
    const client = getClient()
    try {
      const total = (await client.readContract({
        address: factory,
        abi: pndEditionsFactoryAbi,
        functionName: "totalProjects",
      })) as bigint
      const n = Number(total)
      if (n === 0) return []
      const start = Math.max(0, n - limit)
      const idxs = Array.from({ length: n - start }, (_, i) => n - 1 - i) // newest first
      const addrResults = await client.multicall({
        allowFailure: true,
        contracts: idxs.map((i) => ({
          address: factory,
          abi: pndEditionsFactoryAbi,
          functionName: "allProjects" as const,
          args: [BigInt(i)] as const,
        })),
      })
      const addrs = addrResults
        .filter((r) => r.status === "success")
        .map((r) => r.result as Address)
      const projects = await Promise.all(addrs.map((a) => getEditionProject(a)))
      return projects.filter((p): p is EditionProject => p !== null)
    } catch {
      return []
    }
  })
}
