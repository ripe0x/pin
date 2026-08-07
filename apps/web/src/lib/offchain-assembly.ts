import "server-only"
import type { Address } from "viem"
import {
  buildTokenHTML,
  cachedChainResolver,
  defaultGunzip,
  type CodeRefLike,
  type WorkInput,
} from "./collection-render"
import { getClient } from "./collection-onchain"
import { pgCache } from "./pg-cache"
import { PND_CHAIN_ID, ZERO_ADDRESS } from "./collection"

/**
 * Generic offchain document assembly for oversized onchain tokenURIs.
 *
 * A Surface renderer assembles a full HTML document onchain; for a work that
 * inlines large assets or dependency bundles, the `tokenURI` eth_call can
 * exceed what any RPC will serve (escape blue is 5.45B gas). This is the
 * general escape hatch the escape-specific assembler foreshadowed: for any
 * ScriptyRenderer-shaped renderer, reassemble the identical document offchain
 * from the renderer's code refs + chain-fetched bytes, using the parity render
 * library (byte-identical to ScriptyRenderer, asserted in build.test.ts). This
 * module does NOT fork a second assembler: buildTokenHTML is the one builder.
 *
 * A renderer is assemblable when it exposes the ScriptyRenderer getters:
 * code() and deps() (CodeRef[]), injectionVersion(), and the gunzip pointer
 * (gunzipStore()/gunzipFile()). A bespoke renderer without them probes false
 * at one cached eth_call and is never retried within the TTL.
 */

const lc = (a: string) => a.toLowerCase()

const codeRefAbi = [
  { name: "store", type: "address" },
  { name: "name", type: "string" },
  { name: "kind", type: "uint8" },
] as const

const rendererAbi = [
  {
    type: "function",
    name: "code",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "tuple[]", components: codeRefAbi }],
  },
  {
    type: "function",
    name: "deps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "tuple[]", components: codeRefAbi }],
  },
  {
    type: "function",
    name: "injectionVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "gunzipStore",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "gunzipFile",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const

type RawRef = { store: Address; name: string; kind: number }

/** The renderer's work definition + gunzip pointer, or null when the renderer
 *  is not ScriptyRenderer-shaped. */
export type RendererWork = {
  code: CodeRefLike[]
  deps: CodeRefLike[]
  injectionVersion: number
  gunzip: { store: Address; name: string }
}

function toRefs(raw: readonly RawRef[]): CodeRefLike[] {
  return raw.map((r) => ({ store: r.store, name: r.name, kind: Number(r.kind) as 0 | 1 }))
}

/**
 * The renderer's onchain work, read once and cached. Long TTL: a
 * ScriptyRenderer fixes its code/deps in the constructor, so the work is
 * immutable per renderer instance. Returns null (also cached) when the
 * renderer lacks the getters, so an unsupported renderer costs exactly one
 * probe per window. The support decision and the work read are the same
 * multicall, so "is assemblable" and "what to assemble" never diverge.
 */
export async function getRendererWork(renderer: Address): Promise<RendererWork | null> {
  if (!renderer || lc(renderer) === ZERO_ADDRESS) return null
  return pgCache(`sc-renderer-work:${lc(renderer)}`, 3600, async () => {
    const client = getClient()
    const base = { address: renderer, abi: rendererAbi } as const
    try {
      const [code, deps, injectionVersion, gunzipStore, gunzipFile] = await client.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: "code" },
          { ...base, functionName: "deps" },
          { ...base, functionName: "injectionVersion" },
          { ...base, functionName: "gunzipStore" },
          { ...base, functionName: "gunzipFile" },
        ],
      })
      return {
        code: toRefs(code as readonly RawRef[]),
        deps: toRefs(deps as readonly RawRef[]),
        injectionVersion: Number(injectionVersion as number),
        gunzip: { store: gunzipStore as Address, name: gunzipFile as string },
      }
    } catch {
      return null
    }
  })
}

/** Whether a renderer can be assembled offchain (ScriptyRenderer-shaped). One
 *  cached probe; false is cached too. */
export async function isOffchainAssemblable(renderer: Address): Promise<boolean> {
  const work = await getRendererWork(renderer)
  return work !== null && work.code.length > 0
}

/**
 * Assemble a token's document offchain, byte-identical to what the onchain
 * ScriptyRenderer would emit. Reads the work (cached), fetches content bytes
 * via the shared cachedChainResolver, and builds via the parity lib with
 * `context: "token"`. Returns null when the renderer is not assemblable or a
 * content read fails.
 *
 * The assembled output is immutable for a given (renderer, seed): a locked
 * renderer never changes, and the seed is fixed at mint. Cached long. Failures
 * (a transient content read miss) are NOT cached long — a null return skips
 * the pgCache write path, so the next request retries fresh (the
 * over-cached-failure lesson from the escape assembler's history).
 */
export async function assembleTokenDocument(
  collection: Address,
  renderer: Address,
  tokenId: bigint,
  seed: `0x${string}`,
): Promise<string | null> {
  const work = await getRendererWork(renderer)
  if (!work || work.code.length === 0) return null

  const cacheKey = `sc-assembled:${lc(collection)}:${lc(renderer)}:${tokenId.toString()}:${seed}`
  // The fetcher THROWS on failure rather than returning null: pgCache only
  // writes the row after a successful fetch, so a throw leaves nothing cached
  // and the next request retries fresh. Returning null here would cache the
  // failure for the full 24h TTL (the escape assembler's over-cached-failure
  // regression). Successful assembly is immutable, so it caches long.
  try {
    return await pgCache(cacheKey, 86_400, async () => {
      const client = getClient()
      const resolve = cachedChainResolver(client)
      const workInput: WorkInput = {
        code: work.code,
        deps: work.deps,
        injectionVersion: work.injectionVersion,
      }
      // The renderer's own gunzip pointer when set, else the mainnet default
      // the parity lib vendors.
      const gunzip =
        work.gunzip.store && lc(work.gunzip.store) !== ZERO_ADDRESS && work.gunzip.name
          ? work.gunzip
          : defaultGunzip(PND_CHAIN_ID)
      const html = await buildTokenHTML(
        workInput,
        {
          hash: seed,
          tokenId: tokenId.toString(),
          collection: lc(collection),
          chainId: PND_CHAIN_ID,
          version: work.injectionVersion,
          context: "token",
        },
        resolve,
        { gunzip },
      )
      if (!html) throw new Error("offchain-assembly: empty document")
      return html
    })
  } catch {
    return null
  }
}

/** The assembled document as a data:text/html URI, for a token's animation_url
 *  (the same shape ScriptyRenderer's onchain tokenURI would carry). */
export async function assembleTokenAnimationUrl(
  collection: Address,
  renderer: Address,
  tokenId: bigint,
  seed: `0x${string}`,
): Promise<string | null> {
  const html = await assembleTokenDocument(collection, renderer, tokenId, seed)
  if (!html) return null
  const b64 = Buffer.from(html, "utf8").toString("base64")
  return `data:text/html;base64,${b64}`
}
