import "server-only"
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, keccak256, stringToBytes, type Address } from "viem"
import { mainnet } from "viem/chains"
import { catalogAbi, collectionAbi, collectionFactoryAbi, gateHookAbi, renderAssetsAbi } from "@pin/abi"
import { ARTIST_RECORD_REGISTRY, MAINNET_CHAIN_ID, getAddressOrNull } from "@pin/addresses"
import { fetchMetadataForUri } from "@pin/token-metadata"
import { pgCache } from "./pg-cache"
import {
  decodeCollectionConfig,
  gateHookAddress,
  renderAssetsAddress,
  type Collection,
  CollectionStatus,
  IdMode,
  ZERO_ADDRESS,
} from "./collection"

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
    const base = { address, abi: collectionAbi } as const
    try {
      const [name, symbol, owner, rendererLocked, supplyLocked, renderer, priceStrategy, idMode, cfgRes] =
        await client.multicall({
          allowFailure: false,
          contracts: [
            { ...base, functionName: "name" },
            { ...base, functionName: "symbol" },
            { ...base, functionName: "owner" },
            { ...base, functionName: "isRendererLocked" },
            { ...base, functionName: "isSupplyLocked" },
            { ...base, functionName: "renderer" },
            { ...base, functionName: "priceStrategy" },
            { ...base, functionName: "idMode" },
            { ...base, functionName: "config" },
          ],
        })
      const [cfgRaw, status, minted] = cfgRes as RawConfigReturn

      // Presentation data lives in renderer-land: the cover in RenderAssets.
      // Generative work now ships as bring-your-own renderers (each renderer
      // owns its config and tokenURI), so there is no shared work-config read
      // here; the cover read tolerates absence (custom renderer, nothing set).
      const assets = renderAssetsAddress()
      const cover = assets
        ? await client
            .readContract({
              address: assets,
              abi: renderAssetsAbi,
              functionName: "coverOf",
              args: [address],
            })
            .catch(() => "")
        : ""

      return {
        address,
        name: name as string,
        symbol: symbol as string,
        owner: owner as Address,
        isRendererLocked: rendererLocked as boolean,
        isSupplyLocked: supplyLocked as boolean,
        renderer: renderer as Address,
        priceStrategy: priceStrategy as Address,
        cfg: decodeCollectionConfig(cfgRaw, Number(idMode)),
        // Shared work-config read removed with the shared GenerativeRenderer;
        // bring-your-own renderers own their config. Kept as an empty default
        // so consumers that gate on work.code.length fall back to the cover.
        work: { code: [], deps: [], codeURI: "", codeHash: ("0x" + "0".repeat(64)) as `0x${string}`, injectionVersion: 1, renderParams: "" },
        cover: (cover as string) ?? "",
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
  /** Sequential: the token id IS the mint order; null for pooled. */
  mintOrder: number | null
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
    const base = { address, abi: collectionAbi } as const
    try {
      const [ownerRes, seedRes, modeRes] = await client.multicall({
        allowFailure: true,
        contracts: [
          { ...base, functionName: "ownerOf", args: [tokenId] },
          { ...base, functionName: "tokenSeed", args: [tokenId] },
          { ...base, functionName: "idMode", args: [] },
        ],
      })
      // The seed is the was-ever-minted sentinel (tokenSeed reverts otherwise).
      if (seedRes.status !== "success") return null // never minted
      const mintOrder =
        modeRes.status === "success" && Number(modeRes.result) === IdMode.Sequential
          ? Number(tokenId)
          : null
      const collection = ownerRes.status === "success" ? await getCollection(address) : null
      // Static image from renderer-land: the capture if one exists, else the
      // cover — the same resolution the bundled renderers apply.
      const assets = renderAssetsAddress()
      const artwork = assets
        ? await client
            .readContract({
              address: assets,
              abi: renderAssetsAbi,
              functionName: "imageFor",
              args: [address, tokenId],
            })
            .then((v) => (v as string) ?? "")
            .catch(() => collection?.cover ?? "")
        : collection?.cover ?? ""

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
            abi: collectionAbi,
            functionName: "tokenURI",
            args: [tokenId],
          }),
          gas: 300_000_000n,
        })
        .then(({ data }) =>
          data
            ? (decodeFunctionResult({
                abi: collectionAbi,
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
        mintOrder,
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
  firstTokenId: bigint
  count: number
}

export type CollectionMintHistoryResult =
  | { unsupported: false; entries: CollectionMintHistoryEntry[] }
  | { unsupported: "pooled"; entries: [] }

/**
 * Recent mint history for a collection, newest first, grouped into batches
 * of contiguous ids per holder. Read per-token via multicall (ownerOf)
 * rather than getLogs, matching the editions history reader — this works
 * identically on a fork and on mainnet without log-range limits. Mint
 * blocks/timestamps are event data and arrive with the indexer.
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
    const base = { address, abi: collectionAbi } as const
    const startTok = Math.max(1, total - limit + 1)
    const ids: bigint[] = []
    for (let t = total; t >= startTok; t--) ids.push(BigInt(t)) // newest first

    const calls = ids.map(
      (id) => ({ ...base, functionName: "ownerOf" as const, args: [id] as const }),
    )
    const res = await client.multicall({ allowFailure: true, contracts: calls })

    const grouped: CollectionMintHistoryEntry[] = []
    for (let i = 0; i < ids.length; i++) {
      const ownerR = res[i]
      if (ownerR.status !== "success") continue // burned / unreadable
      const holder = ownerR.result as Address
      const tokenId = ids[i]
      const last = grouped[grouped.length - 1]
      // Iterating newest-first; extend a batch when the next (lower) token
      // has the same holder and is contiguous.
      if (
        last &&
        last.holder.toLowerCase() === holder.toLowerCase() &&
        last.firstTokenId === tokenId + 1n
      ) {
        last.firstTokenId = tokenId
        last.count += 1
      } else {
        grouped.push({ holder, firstTokenId: tokenId, count: 1 })
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
        abi: collectionFactoryAbi,
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
          abi: collectionFactoryAbi,
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
        abi: collectionAbi,
        functionName: "currentPrice",
        args: [minter, qty, "0x"],
      })
      return price as bigint
    } catch {
      return null
    }
  })
}

/** The mint-gate state a collection page needs. `isGateHook` means the
 *  collection's hook is the canonical GateHook, so root/cap are readable
 *  and the eligibility UI applies; any other nonzero hook renders the
 *  generic gated-mint notice. */
export type GateState = {
  hook: Address
  isGateHook: boolean
  root: `0x${string}`
  cap: string // bigint as string (serializable to client)
}

const ZERO_ROOT = ("0x" + "0".repeat(64)) as `0x${string}`

/**
 * The active gate for a collection: which hook is attached and, when it's
 * the canonical GateHook, its live root + per-wallet cap. Config-class
 * freshness (20s) — an artist flipping a gate mid-drop propagates on the
 * same cadence as every other sale setting.
 */
export async function getGateState(address: Address): Promise<GateState | null> {
  return pgCache(`sc-gate:${lc(address)}`, 20, async () => {
    const client = getClient()
    try {
      const hook = (await client.readContract({
        address,
        abi: collectionAbi,
        functionName: "mintHook",
      })) as Address
      if (hook === ZERO_ADDRESS) return null
      const gate = gateHookAddress()
      const isGateHook = !!gate && lc(hook) === lc(gate)
      if (!isGateHook) return { hook, isGateHook: false, root: ZERO_ROOT, cap: "0" }
      const [root, cap] = await Promise.all([
        client.readContract({
          address: hook,
          abi: gateHookAbi,
          functionName: "rootOf",
          args: [address],
        }),
        client.readContract({
          address: hook,
          abi: gateHookAbi,
          functionName: "capOf",
          args: [address],
        }),
      ])
      return {
        hook,
        isGateHook: true,
        root: root as `0x${string}`,
        cap: (cap as bigint).toString(),
      }
    } catch {
      return null
    }
  })
}

/** Minimal ABI for the OPTIONAL IPreviewRenderer extension — declared
 *  standalone so any renderer address can be probed, not just ours. */
const previewRendererAbi = [
  {
    type: "function",
    name: "previewURI",
    stateMutability: "view",
    inputs: [
      { name: "collection", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "seed", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
] as const

export type OnchainPreview = {
  seedIndex: number
  image: string | null
  animationUrl: string | null
}

/** Deterministic explore seed, same string convention as the client wall
 *  (GenerativeViews.exploreSeed) so a given index shows the same output on
 *  either path. */
function onchainExploreSeed(collection: Address, i: number): `0x${string}` {
  return keccak256(stringToBytes(`${collection.toLowerCase()}:explore:${i}`))
}

/**
 * One onchain preview from a renderer implementing the OPTIONAL
 * IPreviewRenderer extension: previewURI(collection, nextTokenId, seed),
 * decoded to its image/animation_url. Null when the renderer doesn't
 * implement previews (detection is this try/catch, per repo convention).
 *
 * Same dedicated high-gas call path as tokenURI (never multicalled):
 * scripty-class renderers can cost 60-120M gas per call. Long TTL — a
 * preview for a fixed seed only changes if the renderer/work changes.
 */
export async function getRendererPreview(
  collection: Address,
  renderer: Address,
  nextTokenId: bigint,
  seedIndex: number,
): Promise<OnchainPreview | null> {
  // Long TTL: a preview for a fixed (collection, renderer, seedIndex) is
  // immutable — the seed and the renderer bytecode fully determine it, and
  // the renderer address is in the key, so a renderer swap gets fresh keys.
  // Caching a day keeps a large sample pool essentially free to serve.
  return pgCache(`sc-prev:${lc(collection)}:${lc(renderer)}:${seedIndex}`, 86_400, async () => {
    const client = getClient()
    const uri = await client
      .call({
        to: renderer,
        data: encodeFunctionData({
          abi: previewRendererAbi,
          functionName: "previewURI",
          args: [collection, nextTokenId, onchainExploreSeed(collection, seedIndex)],
        }),
        gas: 300_000_000n,
      })
      .then(({ data }) =>
        data
          ? (decodeFunctionResult({
              abi: previewRendererAbi,
              functionName: "previewURI",
              data,
            }) as string)
          : null,
      )
      .catch(() => null)
    if (!uri) return null
    const meta = await fetchMetadataForUri(uri, nextTokenId, 8_000).catch(() => null)
    if (!meta) return null
    return {
      seedIndex,
      image: meta.image ?? null,
      animationUrl: (meta as { animation_url?: string }).animation_url ?? null,
    }
  })
}

/** The first `count` onchain previews, or null when the renderer doesn't
 *  support them (probed with index 0; unsupported renderers cost exactly
 *  one cached failed call). */
export async function getRendererPreviews(
  collection: Address,
  renderer: Address,
  nextTokenId: bigint,
  count: number,
): Promise<OnchainPreview[] | null> {
  const first = await getRendererPreview(collection, renderer, nextTokenId, 0)
  if (!first) return null
  const rest = await Promise.all(
    Array.from({ length: count - 1 }, (_, i) =>
      getRendererPreview(collection, renderer, nextTokenId, i + 1),
    ),
  )
  return [first, ...rest.filter((p): p is OnchainPreview => p !== null)]
}

export type RecentTokenEntry = {
  tokenId: string
  seed: `0x${string}`
}

/**
 * Seeds for the latest mints, newest first: everything a client-side parity
 * render needs (tokenData is hash + tokenId), at one cheap slot read instead
 * of the 60-120M-gas tokenURI. Sequential collections only (pooled ids
 * arrive with the indexer, same rationale as mint history).
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
    const base = { address, abi: collectionAbi } as const
    const from = minted
    const to = minted > BigInt(limit) ? minted - BigInt(limit) + 1n : 1n
    const ids: bigint[] = []
    for (let id = from; id >= to; id--) ids.push(id)
    try {
      const res = await client.multicall({
        allowFailure: true,
        contracts: ids.map((id) => ({ ...base, functionName: "tokenSeed", args: [id] }) as const),
      })
      const entries: RecentTokenEntry[] = []
      ids.forEach((id, i) => {
        const seedRes = res[i]
        if (seedRes.status !== "success") return
        entries.push({ tokenId: id.toString(), seed: seedRes.result as `0x${string}` })
      })
      return entries
    } catch {
      return []
    }
  })
}

export type CreatorEntry = { creator: Address; confirmed: boolean }
export type AttributionEntry = CreatorEntry // back-compat alias

/**
 * Confirmed creators for a collection. Attribution is now fully onchain on the
 * collection itself: the owner LISTS creators (`CreatorListed` events) and each
 * confirms by claiming the collection in the Catalog; the collection exposes
 * `isConfirmedCreator(who)` as the live intersection.
 *
 * The listed set is enumerated from indexed `CreatorListed` events (worker owns
 * chain scanning; web never scans), so this returns [] until the indexer serves
 * them. Given a candidate set, confirmation is a live `isConfirmedCreator` read.
 * There is no shared Attribution registry to read anymore.
 */
export async function getAttribution(_collection: Address): Promise<CreatorEntry[]> {
  return []
}
