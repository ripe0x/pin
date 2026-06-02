import "server-only"
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { pndEditionsAbi, pndEditionsFactoryAbi } from "@pin/abi"
import { pgCache } from "./pg-cache"
import {
  decodeConfig,
  decodeMintMark,
  type Edition,
  type EditionEdge,
  type EditionMintMark,
  type EditionPath,
  EditionStatus,
  PND_CHAIN_ID,
} from "./pnd-editions"

/**
 * Live, cached onchain reads for PND Editions. These are the edition's own
 * contracts (no indexer backfill required for the live mint/provenance
 * surfaces). pgCache short-circuits to a fresh read when no DATABASE_URL.
 *
 * Always uses the mainnet chain object so viem resolves the canonical
 * Multicall3; in fork mode the transport points at Anvil (which forks mainnet,
 * so Multicall3 is present). viem doesn't validate chainId on reads.
 */

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"

function getClient() {
  if (FORK_MODE) {
    const url = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545"
    return createPublicClient({ chain: mainnet, transport: http(url) })
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

type RawConfigReturn = readonly [Parameters<typeof decodeConfig>[0], number, bigint]
type RawPath = {
  pathType: number
  target: { chainId: bigint; contractAddress: Address; id: bigint; kind: number }
  data: `0x${string}`
}

/** Full edition: identity, config, live status + minted count. Short TTL. */
export async function getEdition(address: Address): Promise<Edition | null> {
  return pgCache(`pnd-edition:${lc(address)}`, 20, async () => {
    const client = getClient()
    const base = { address, abi: pndEditionsAbi } as const
    try {
      const [name, symbol, owner, totalSupply, upgradeable, sealedFlag, cfgRes] =
        await client.multicall({
          allowFailure: false,
          contracts: [
            { ...base, functionName: "name" },
            { ...base, functionName: "symbol" },
            { ...base, functionName: "owner" },
            { ...base, functionName: "totalSupply" },
            { ...base, functionName: "isUpgradeable" },
            { ...base, functionName: "isSealed" },
            { ...base, functionName: "config" },
          ],
        })
      const [cfgRaw, status, minted] = cfgRes as RawConfigReturn
      return {
        address,
        name: name as string,
        symbol: symbol as string,
        owner: owner as Address,
        totalSupply: totalSupply as bigint,
        isUpgradeable: upgradeable as boolean,
        isSealed: sealedFlag as boolean,
        cfg: decodeConfig(cfgRaw),
        status: Number(status) as EditionStatus,
        minted: minted as bigint,
      }
    } catch {
      return null
    }
  })
}

/** Edition Graph edges for an edition. */
export async function getEditionEdges(address: Address): Promise<EditionEdge[]> {
  return pgCache(`pnd-edges:${lc(address)}`, 120, async () => {
    const client = getClient()
    try {
      const edges = (await client.readContract({
        address,
        abi: pndEditionsAbi,
        functionName: "edges",
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
  edition: Edition | null
}

/** Everything the token page needs: Mint Mark, art, path, owner. */
export async function getEditionToken(
  address: Address,
  tokenId: bigint,
): Promise<EditionTokenView | null> {
  return pgCache(`pnd-token:${lc(address)}:${tokenId.toString()}`, 60, async () => {
    const client = getClient()
    const base = { address, abi: pndEditionsAbi } as const
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
      const mark = decodeMintMark(markRes.result as Parameters<typeof decodeMintMark>[0])
      const edition = await getEdition(address)
      const tokenArt = artRes.status === "success" ? (artRes.result as string) : ""
      const artwork = tokenArt && tokenArt.length > 0 ? tokenArt : edition?.cfg.artworkURI ?? ""
      const rawPath = pathRes.status === "success" ? (pathRes.result as RawPath) : null
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
        : {
            pathType: 0,
            target: { chainId: PND_CHAIN_ID, contractAddress: address, id: 0n, kind: 0 },
            data: "0x" as `0x${string}`,
          }
      return {
        tokenId,
        owner: ownerRes.status === "success" ? (ownerRes.result as Address) : null,
        mark,
        artwork,
        path,
        edition,
      }
    } catch {
      return null
    }
  })
}

export type MintHistoryEntry = {
  holder: Address
  mintBlock: bigint
  firstTokenId: bigint
  count: number
}

/**
 * Recent mint history for an edition, newest first, grouped into batches by
 * (holder, block). Read per-token via multicall (ownerOf + mintMarkOf) rather
 * than getLogs, so it works identically on a fork and on mainnet without
 * log-range limits. `minted` (= the edition's total minted, from getEdition)
 * is passed in to avoid a redundant read.
 */
export async function getEditionMintHistory(
  address: Address,
  minted: bigint,
  limit = 40,
): Promise<MintHistoryEntry[]> {
  const total = Number(minted)
  if (total === 0) return []
  return pgCache(`pnd-history:${lc(address)}:${total}`, 30, async () => {
    const client = getClient()
    const base = { address, abi: pndEditionsAbi } as const
    const startTok = Math.max(1, total - limit + 1)
    const ids: bigint[] = []
    for (let t = total; t >= startTok; t--) ids.push(BigInt(t)) // newest first

    const calls = ids.flatMap((id) => [
      { ...base, functionName: "ownerOf" as const, args: [id] as const },
      { ...base, functionName: "mintMarkOf" as const, args: [id] as const },
    ])
    const res = await client.multicall({ allowFailure: true, contracts: calls })

    const grouped: MintHistoryEntry[] = []
    for (let i = 0; i < ids.length; i++) {
      const ownerR = res[i * 2]
      const markR = res[i * 2 + 1]
      if (ownerR.status !== "success") continue // burned / unreadable
      const holder = ownerR.result as Address
      const mark = markR.status === "success" ? (markR.result as { mintBlock: number | bigint }) : null
      const mintBlock = mark ? BigInt(mark.mintBlock) : 0n
      const tokenId = ids[i]
      const last = grouped[grouped.length - 1]
      // Iterating newest-first; extend a batch when the next (lower) token has
      // the same holder + block and is contiguous.
      if (
        last &&
        last.holder.toLowerCase() === holder.toLowerCase() &&
        last.mintBlock === mintBlock &&
        last.firstTokenId === tokenId + 1n
      ) {
        last.firstTokenId = tokenId
        last.count += 1
      } else {
        grouped.push({ holder, mintBlock, firstTokenId: tokenId, count: 1 })
      }
    }
    return grouped
  })
}

/** Recent editions from the factory, newest first. For the landing. */
export async function getRecentEditions(factory: Address, limit = 8): Promise<Edition[]> {
  return pgCache(`pnd-recent:${lc(factory)}:${limit}`, 60, async () => {
    const client = getClient()
    try {
      const total = (await client.readContract({
        address: factory,
        abi: pndEditionsFactoryAbi,
        functionName: "totalEditions",
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
          functionName: "allEditions" as const,
          args: [BigInt(i)] as const,
        })),
      })
      const addrs = addrResults
        .filter((r) => r.status === "success")
        .map((r) => r.result as Address)
      const editions = await Promise.all(addrs.map((a) => getEdition(a)))
      return editions.filter((e): e is Edition => e !== null)
    } catch {
      return []
    }
  })
}
