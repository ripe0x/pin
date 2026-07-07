import "server-only"
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { attributionAbi, catalogAbi, sovereignCollectionAbi, sovereignCollectionFactoryAbi } from "@pin/abi"
import { ARTIST_RECORD_REGISTRY, ATTRIBUTION, MAINNET_CHAIN_ID, getAddressOrNull } from "@pin/addresses"
import { fetchMetadataForUri } from "@pin/token-metadata"
import { pgCache } from "./pg-cache"
import {
  attributionAddress,
  decodeCollectionConfig,
  decodeMintMark,
  decodeWorkConfig,
  type Collection,
  type MintMark,
  CollectionStatus,
  IdMode,
} from "./sovereign-collection"

/**
 * Live, cached onchain reads for Sovereign Collections. These are the
 * collection's own contracts (no indexer backfill required for the live
 * mint/provenance surfaces). pgCache short-circuits to a fresh read when no
 * DATABASE_URL.
 *
 * Always uses the mainnet chain object so viem resolves the canonical
 * Multicall3; in fork mode the transport points at Anvil (which forks
 * mainnet, so Multicall3 is present). viem doesn't validate chainId on
 * reads. Mirrors lib/editions-onchain.ts's client construction exactly.
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

const REGISTRY = getAddressOrNull(ARTIST_RECORD_REGISTRY, MAINNET_CHAIN_ID)

type RawConfigReturn = readonly [Parameters<typeof decodeCollectionConfig>[0], number, bigint]

/**
 * Full collection: identity, config, live status + minted count, plus the
 * mutable slot values (renderer/priceStrategy can be swapped post-deploy, so
 * they're read live rather than trusted from `cfg`). Short TTL.
 */
export async function getCollection(address: Address): Promise<Collection | null> {
  return pgCache(`sc-collection:${lc(address)}`, 20, async () => {
    const client = getClient()
    const base = { address, abi: sovereignCollectionAbi } as const
    try {
      const [name, symbol, owner, workLocked, metadataFrozen, permanent, renderer, priceStrategy, cfgRes, workRaw] =
        await client.multicall({
          allowFailure: false,
          contracts: [
            { ...base, functionName: "name" },
            { ...base, functionName: "symbol" },
            { ...base, functionName: "owner" },
            { ...base, functionName: "isWorkLocked" },
            { ...base, functionName: "isMetadataFrozen" },
            { ...base, functionName: "isPermanent" },
            { ...base, functionName: "renderer" },
            { ...base, functionName: "priceStrategy" },
            { ...base, functionName: "config" },
            { ...base, functionName: "workConfig" },
          ],
        })
      const [cfgRaw, status, minted] = cfgRes as RawConfigReturn
      return {
        address,
        name: name as string,
        symbol: symbol as string,
        owner: owner as Address,
        isWorkLocked: workLocked as boolean,
        isMetadataFrozen: metadataFrozen as boolean,
        isPermanent: permanent as boolean,
        renderer: renderer as Address,
        priceStrategy: priceStrategy as Address,
        cfg: decodeCollectionConfig(cfgRaw),
        work: decodeWorkConfig(workRaw as Parameters<typeof decodeWorkConfig>[0]),
        status: Number(status) as CollectionStatus,
        minted: minted as bigint,
      }
    } catch {
      return null
    }
  })
}

export type CollectionTokenView = {
  tokenId: bigint
  owner: Address | null
  mark: MintMark
  seed: `0x${string}` | null
  artwork: string
  tokenURI: string | null
  /** Decoded from tokenURI (data:/IPFS/HTTP JSON). Falls back to `artwork`
   *  when tokenURI didn't resolve or carries no image field, so a renderer
   *  that doesn't emit metadata JSON still has something to show. */
  image: string
  /** Decoded from tokenURI. Present when the active renderer emits an
   *  animation_url (e.g. GenerativeRenderer's built HTML document); null for
   *  a static-image renderer (e.g. DefaultRenderer). */
  animationUrl: string | null
}

/** Everything a token page needs: owner, seed, Mint Mark, art, tokenURI. */
export async function getCollectionToken(
  address: Address,
  tokenId: bigint,
): Promise<CollectionTokenView | null> {
  return pgCache(`sc-token:${lc(address)}:${tokenId.toString()}`, 60, async () => {
    const client = getClient()
    const base = { address, abi: sovereignCollectionAbi } as const
    try {
      const [ownerRes, seedRes, markRes, artRes] = await client.multicall({
        allowFailure: true,
        contracts: [
          { ...base, functionName: "ownerOf", args: [tokenId] },
          { ...base, functionName: "tokenSeed", args: [tokenId] },
          { ...base, functionName: "mintMarkOf", args: [tokenId] },
          { ...base, functionName: "tokenArtwork", args: [tokenId] },
        ],
      })
      if (markRes.status !== "success") return null // never minted / burned
      const mark = decodeMintMark(markRes.result as Parameters<typeof decodeMintMark>[0])
      const collection = ownerRes.status === "success" ? await getCollection(address) : null
      const tokenArt = artRes.status === "success" ? (artRes.result as string) : ""
      const artwork = tokenArt && tokenArt.length > 0 ? tokenArt : collection?.cfg.artworkURI ?? ""

      // tokenURI gets its own call with an explicit gas ceiling, NEVER the
      // multicall: assembling a full onchain HTML document (GenerativeRenderer
      // over a gzipped p5) measures 60-120M gas, far beyond the ~30M default
      // eth_call cap and any multicall budget. Elevated-gas eth_call is the
      // standard way heavyweight onchain-HTML tokenURIs are served; consumers
      // with lower caps use the capture worker's static image instead.
      const rawTokenUri = await client
        .call({
          to: address,
          data: encodeFunctionData({
            abi: sovereignCollectionAbi,
            functionName: "tokenURI",
            args: [tokenId],
          }),
          gas: 300_000_000n,
        })
        .then(({ data }) =>
          data
            ? (decodeFunctionResult({
                abi: sovereignCollectionAbi,
                functionName: "tokenURI",
                data,
              }) as string)
            : null,
        )
        .catch(() => null)

      // Decode the already-fetched tokenURI (no extra RPC call) to recover
      // `image` / `animation_url` the same way every other token page on
      // this site does — see @pin/token-metadata's doc comment. A renderer
      // that emits an animation_url (GenerativeRenderer) needs this to show
      // the live/generative work rather than just its poster image.
      let image = artwork
      let animationUrl: string | null = null
      if (rawTokenUri) {
        const meta = await fetchMetadataForUri(rawTokenUri, tokenId, 8_000).catch(() => null)
        if (meta?.image) image = meta.image
        if (meta?.animation_url) animationUrl = meta.animation_url
      }

      return {
        tokenId,
        owner: ownerRes.status === "success" ? (ownerRes.result as Address) : null,
        mark,
        seed: seedRes.status === "success" ? (seedRes.result as `0x${string}`) : null,
        artwork,
        tokenURI: rawTokenUri,
        image,
        animationUrl,
      }
    } catch {
      return null
    }
  })
}

export type CollectionMintHistoryEntry = {
  holder: Address
  mintBlock: bigint
  firstTokenId: bigint
  count: number
}

export type CollectionMintHistoryResult =
  | { unsupported: false; entries: CollectionMintHistoryEntry[] }
  | { unsupported: "pooled"; entries: [] }

/**
 * Recent mint history for a collection, newest first, grouped into batches
 * by (holder, block). Read per-token via multicall (ownerOf + mintMarkOf)
 * rather than getLogs, matching the editions history reader — this works
 * identically on a fork and on mainnet without log-range limits.
 *
 * Sequential-mode only. In Sequential mode token ids are exactly 1..minted
 * (the core assigns `nextId++`, never reused after burn), so "the last N
 * ids" is a correct approximation of "the last N mints" the same way the
 * editions reader relies on it.
 *
 * Pooled mode has no such invariant: an authorized minter supplies
 * arbitrary/reused ids (tokenId == sourceId), and a burned id can be
 * re-minted as a new instance. Reconstructing "which ids exist and in what
 * order they were minted" for Pooled requires walking Minted/Burned events,
 * which this repo's RPC policy forbids from a web request (see AGENTS.md:
 * the worker owns all chain scanning; web never scans). Rather than fake a
 * partial or misleading history, Pooled returns an explicit unsupported
 * marker; real pooled history arrives once the indexer picks up
 * Minted/Burned for collections (tracked alongside the rest of the
 * collection discovery work).
 */
export async function getCollectionMintHistory(
  address: Address,
  minted: bigint,
  idMode: IdMode,
  limit = 40,
): Promise<CollectionMintHistoryResult> {
  if (idMode === IdMode.Pooled) {
    return { unsupported: "pooled", entries: [] }
  }
  const total = Number(minted)
  if (total === 0) return { unsupported: false, entries: [] }
  return pgCache(`sc-history:${lc(address)}:${total}`, 30, async () => {
    const client = getClient()
    const base = { address, abi: sovereignCollectionAbi } as const
    const startTok = Math.max(1, total - limit + 1)
    const ids: bigint[] = []
    for (let t = total; t >= startTok; t--) ids.push(BigInt(t)) // newest first

    const calls = ids.flatMap((id) => [
      { ...base, functionName: "ownerOf" as const, args: [id] as const },
      { ...base, functionName: "mintMarkOf" as const, args: [id] as const },
    ])
    const res = await client.multicall({ allowFailure: true, contracts: calls })

    const grouped: CollectionMintHistoryEntry[] = []
    for (let i = 0; i < ids.length; i++) {
      const ownerR = res[i * 2]
      const markR = res[i * 2 + 1]
      if (ownerR.status !== "success") continue // burned / unreadable
      const holder = ownerR.result as Address
      const mark =
        markR.status === "success" ? (markR.result as { mintBlock: number | bigint }) : null
      const mintBlock = mark ? BigInt(mark.mintBlock) : 0n
      const tokenId = ids[i]
      const last = grouped[grouped.length - 1]
      // Iterating newest-first; extend a batch when the next (lower) token
      // has the same holder + block and is contiguous.
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
    return { unsupported: false, entries: grouped }
  })
}

/** Recent collections from the factory, newest first. For the landing. */
export async function getRecentCollections(factory: Address, limit = 8): Promise<Collection[]> {
  return pgCache(`sc-recent:${lc(factory)}:${limit}`, 60, async () => {
    const client = getClient()
    try {
      const total = (await client.readContract({
        address: factory,
        abi: sovereignCollectionFactoryAbi,
        functionName: "totalCollections",
      })) as bigint
      const n = Number(total)
      if (n === 0) return []
      const start = Math.max(0, n - limit)
      const idxs = Array.from({ length: n - start }, (_, i) => n - 1 - i) // newest first
      const addrResults = await client.multicall({
        allowFailure: true,
        contracts: idxs.map((i) => ({
          address: factory,
          abi: sovereignCollectionFactoryAbi,
          functionName: "allCollections" as const,
          args: [BigInt(i)] as const,
        })),
      })
      const addrs = addrResults
        .filter((r) => r.status === "success")
        .map((r) => r.result as Address)
      const collections = await Promise.all(addrs.map((a) => getCollection(a)))
      return collections.filter((c): c is Collection => c !== null)
    } catch {
      return []
    }
  })
}

/**
 * Resolved price for a prospective mint: the strategy's live quote if one is
 * set, else the stored fixed price times quantity (currentPrice() on the
 * collection encodes this branch itself, so this is always the single
 * source of truth for "what would this mint cost right now").
 *
 * Short 5s TTL rather than the longer TTLs used elsewhere in this file:
 * dynamic price strategies (e.g. basefee-driven) can change every block, and
 * showing a stale price risks a mint transaction reverting on
 * Underpayment/WrongPayment. 5s still collapses a traffic burst across
 * Netlify sandboxes into one upstream read per window, per the repo's
 * pgCache L2 pattern, without holding a quote long enough to go visibly
 * stale against a fast-moving strategy.
 */
export async function getCurrentPrice(
  address: Address,
  minter: Address,
  qty: bigint,
): Promise<bigint | null> {
  return pgCache(`sc-price:${lc(address)}:${lc(minter)}:${qty.toString()}`, 5, async () => {
    const client = getClient()
    try {
      const price = await client.readContract({
        address,
        abi: sovereignCollectionAbi,
        functionName: "currentPrice",
        args: [minter, qty, "0x"],
      })
      return price as bigint
    } catch {
      return null
    }
  })
}

export type AttributionEntry = { artist: Address; claimed: boolean }

/**
 * A collection's artist roster, cross-checked against each artist's own
 * Catalog claim. Attribution.artistsOf is a one-sided assertion (the
 * collection's owner declaring who collaborated); Catalog.isContractRegistered
 * is the other half (the artist itself claiming the collection). Per
 * Attribution.sol's documented model, "confirmed" is the intersection of
 * both — computed here, off-chain, since the two singletons are
 * deliberately decoupled onchain.
 *
 * Returns an empty array when Attribution isn't configured for the current
 * chain, or when the collection's roster is empty/unset.
 */
export type RecentTokenEntry = {
  tokenId: string
  seed: `0x${string}`
  mintIndex: number
  mintBlock: number
}

/**
 * Seeds + marks for the latest mints, newest first: everything a client-side
 * parity render needs (tokenData for real tokens), at one cheap slot read per
 * field instead of the 60-120M-gas tokenURI. Sequential collections only
 * (pooled ids arrive with the indexer, same rationale as mint history).
 */
export async function getRecentTokenMarks(
  address: Address,
  minted: bigint,
  idMode: IdMode,
  limit = 8,
): Promise<RecentTokenEntry[]> {
  if (idMode !== IdMode.Sequential || minted === 0n) return []
  return pgCache(`sc-recent-marks:${lc(address)}:${minted.toString()}:${limit}`, 60, async () => {
    const client = getClient()
    const base = { address, abi: sovereignCollectionAbi } as const
    const from = minted
    const to = minted > BigInt(limit) ? minted - BigInt(limit) + 1n : 1n
    const ids: bigint[] = []
    for (let id = from; id >= to; id--) ids.push(id)
    try {
      const res = await client.multicall({
        allowFailure: true,
        contracts: ids.flatMap((id) => [
          { ...base, functionName: "tokenSeed", args: [id] } as const,
          { ...base, functionName: "mintMarkOf", args: [id] } as const,
        ]),
      })
      const entries: RecentTokenEntry[] = []
      ids.forEach((id, i) => {
        const seedRes = res[i * 2]
        const markRes = res[i * 2 + 1]
        if (seedRes.status !== "success" || markRes.status !== "success") return
        const mark = decodeMintMark(markRes.result as Parameters<typeof decodeMintMark>[0])
        entries.push({
          tokenId: id.toString(),
          seed: seedRes.result as `0x${string}`,
          mintIndex: mark.mintIndex,
          mintBlock: Number(mark.mintBlock),
        })
      })
      return entries
    } catch {
      return []
    }
  })
}

export async function getAttribution(collection: Address): Promise<AttributionEntry[]> {
  return pgCache(`sc-attribution:${lc(collection)}`, 60, async () => {
    // attributionAddress() honors the NEXT_PUBLIC_ATTRIBUTION env override
    // (the dev fork harness sets it); the static entry is a zero sentinel
    // until mainnet deploy, so reading it directly returns [] forever.
    const attribution = attributionAddress()
    if (!attribution) return []
    const client = getClient()
    try {
      const artists = (await client.readContract({
        address: attribution,
        abi: attributionAbi,
        functionName: "artistsOf",
        args: [collection],
      })) as readonly Address[]
      if (artists.length === 0) return []
      if (!REGISTRY) {
        // No Catalog registry configured: report the roster as unconfirmed
        // rather than silently dropping it.
        return artists.map((artist) => ({ artist, claimed: false }))
      }
      const claimResults = await client.multicall({
        allowFailure: true,
        contracts: artists.map((artist) => ({
          address: REGISTRY,
          abi: catalogAbi,
          functionName: "isContractRegistered" as const,
          args: [artist, collection] as const,
        })),
      })
      return artists.map((artist, i) => ({
        artist,
        claimed: claimResults[i].status === "success" ? Boolean(claimResults[i].result) : false,
      }))
    } catch {
      return []
    }
  })
}
