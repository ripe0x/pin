/**
 * Token metadata + media via on-chain `tokenURI` reads.
 *
 * Reservoir's NFT API was the original primary source but they shut it down
 * Oct 2025. The viable replacements (Alchemy, Moralis, OpenSea) all require
 * API keys, which would defeat the zero-signup deploy goal of this template.
 * Direct `tokenURI` reads + IPFS-gateway race work fine for the volume a
 * personal artist page sees.
 *
 * Three URI shapes we have to handle:
 *
 *  - `data:application/json;...,{...}` — parse the body inline, never fetch.
 *    Many minimal/on-chain-art contracts (e.g. zorb-style SVGs) embed full
 *    metadata + a `data:image/svg+xml;base64,...` image right in the token
 *    URI. The body can be raw JSON, percent-encoded, or base64.
 *  - `ipfs://...` — race a few public gateways and use the first response.
 *  - `https://...` — straight fetch.
 *
 * We don't resolve `image` URLs from the metadata at all when they're already
 * `data:` URLs — `<img>` renders them directly. IPFS images get rewritten
 * through the first gateway so Next.js can range-request them.
 */
import "server-only"
import { unstable_cache } from "next/cache"
import { type Address } from "viem"
import { getClient } from "./rpc"
import { erc721Abi } from "./abi"

// Public IPFS gateways, raced concurrently (first valid JSON wins). Keep the
// first entry an image host allowed in next.config.ts — `resolveImageUri`
// routes `ipfs://` images through IPFS_GATEWAYS[0]. cloudflare-ipfs.com was
// removed: Cloudflare shut down its public IPFS gateway, so it only ever
// failed (and, under the old sequential loop, burned timeout doing so).
const IPFS_GATEWAYS = [
  "https://nftstorage.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
]

export type TokenMetadata = {
  name: string
  description: string
  /** May be an HTTPS URL, an IPFS-gateway URL, or a `data:` URL. */
  image: string | null
  /** Same as `image` for now; reserved for future thumbnail support. */
  imageSmall: string | null
  collectionName: string | null
  artistDisplay: string | null
}

/**
 * Cached token-metadata fetch.
 *
 * Two deliberate properties:
 *
 *  1. **Long TTL (24h).** Minted NFT metadata is immutable, so there's no
 *     reason to re-fetch hourly — that only adds load on flaky public
 *     gateways and widens the window to hit a transient failure. A daily
 *     revalidate still eventually picks up reveal collections (tokenURI
 *     swapped from placeholder to final) and late IPFS pin propagation.
 *
 *  2. **Never cache a failure.** The inner function *throws* when metadata
 *     can't be loaded instead of returning null. `unstable_cache` does not
 *     persist a rejected promise, so a transient gateway blip isn't baked in
 *     for the TTL — and on a *revalidation* failure of an already-cached
 *     token, Next keeps serving the last-good value rather than replacing it
 *     with a placeholder. The public wrapper catches the throw and returns
 *     null so a cold miss still renders the `#tokenId` placeholder for that
 *     one render, then retries on the next request.
 */
// Module-level so the reference is stable across calls — `unstable_cache`
// keys partly on the callback identity. Throws on failure (see
// getTokenMetadata) so a transient miss is never persisted.
async function fetchTokenMetadataOrThrow(
  tokenContract: Address,
  tokenId: string,
): Promise<TokenMetadata> {
  const metadata = await fetchFromTokenUri(tokenContract, tokenId)
  if (!metadata) {
    throw new Error(
      `token metadata unavailable for ${tokenContract}/${tokenId}`,
    )
  }
  return metadata
}

/** Per-token cache tag — lets the revalidate endpoint refresh one token. */
export function tokenMetadataTag(
  tokenContract: Address,
  tokenId: string,
): string {
  return `token-metadata:${tokenContract.toLowerCase()}:${tokenId}`
}

/** Global tag — refreshes every token's metadata at once. */
export const TOKEN_METADATA_TAG = "token-metadata"

export async function getTokenMetadata(
  tokenContract: Address,
  tokenId: string,
): Promise<TokenMetadata | null> {
  // `unstable_cache` is instantiated per call so its `tags` can include the
  // token-specific tag (the option is otherwise static at definition time).
  // The cache key is the stable callback + keyParts, so same-token calls
  // still share one entry. See `app/api/revalidate` for the trigger.
  const cached = unstable_cache(
    fetchTokenMetadataOrThrow,
    ["token-metadata-v3", tokenContract.toLowerCase(), tokenId],
    {
      revalidate: 60 * 60 * 24,
      tags: [TOKEN_METADATA_TAG, tokenMetadataTag(tokenContract, tokenId)],
    },
  )
  try {
    return await cached(tokenContract, tokenId)
  } catch {
    return null
  }
}

async function fetchFromTokenUri(
  tokenContract: Address,
  tokenId: string,
): Promise<TokenMetadata | null> {
  const client = getClient()
  let uri: string
  try {
    uri = (await client.readContract({
      address: tokenContract,
      abi: erc721Abi,
      functionName: "tokenURI",
      args: [BigInt(tokenId)],
    })) as string
  } catch {
    return null
  }

  const json = await loadMetadataJson(uri)
  if (!json) return null

  const rawImage = typeof json.image === "string" ? json.image : null
  const image = rawImage ? resolveImageUri(rawImage) : null
  return {
    name: typeof json.name === "string" ? json.name : `#${tokenId}`,
    description: typeof json.description === "string" ? json.description : "",
    image,
    imageSmall: image,
    collectionName: null,
    artistDisplay: null,
  }
}

/**
 * Resolve any `tokenURI` value into a JSON object. Handles `data:` URLs
 * inline (parsing JSON, base64, or percent-encoded payloads); races IPFS
 * gateways; falls back to a direct `fetch` for HTTPS URLs.
 */
async function loadMetadataJson(
  uri: string,
): Promise<Record<string, unknown> | null> {
  if (uri.startsWith("data:")) {
    return parseDataUrlJson(uri)
  }
  const candidates = expandIpfsUri(uri)
  // Race all candidates concurrently — the fastest healthy gateway wins, so
  // one slow/dead gateway never holds up (or sinks) the fetch. For non-IPFS
  // URLs (https/arweave) `candidates` is a single URL. Retry the whole race
  // once to ride out a momentary blip before giving up for this render.
  for (let attempt = 0; attempt < 2; attempt++) {
    const json = await raceForJson(candidates)
    if (json) return json
  }
  return null
}

/**
 * Resolve the first candidate URL that returns valid JSON. Uses
 * `Promise.any`, which fulfils with the first success and only rejects when
 * *every* candidate fails — so a 404 / timeout / non-JSON body on one gateway
 * is ignored as long as another answers.
 */
async function raceForJson(
  urls: string[],
): Promise<Record<string, unknown> | null> {
  try {
    return await Promise.any(urls.map(fetchJson))
  } catch {
    return null
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`)
  // JSON.parse throwing on a non-JSON body counts as a rejection, so
  // Promise.any falls through to another candidate.
  return JSON.parse(await res.text()) as Record<string, unknown>
}

/**
 * Parse a `data:application/json,...` URL inline. Supports the common
 * encodings:
 *
 *  - raw JSON: `data:application/json,{"name":"…"}`
 *  - utf-8 charset: `data:application/json;charset=utf-8,{...}`
 *  - non-standard utf8 param (zorb-style): `data:application/json;utf8,{...}`
 *  - base64: `data:application/json;base64,eyJ…=`
 *  - percent-encoded: `data:application/json,%7B%22name%22%3A%22…`
 *
 * Returns null if the URL isn't JSON or the body fails to parse.
 */
function parseDataUrlJson(url: string): Record<string, unknown> | null {
  const comma = url.indexOf(",")
  if (comma === -1) return null
  const header = url.slice(5, comma) // strip "data:"
  const body = url.slice(comma + 1)

  // Header looks like: "<mediatype>;<param>;...;<base64?>"
  const parts = header.split(";").map((p) => p.trim())
  const mediatype = parts[0] || "text/plain"
  const isBase64 = parts.some((p) => p.toLowerCase() === "base64")

  // Bail if it's not JSON-shaped. Accept */json, */json+ld, etc.
  if (!/json/i.test(mediatype) && mediatype !== "application/octet-stream") {
    return null
  }

  let text: string
  if (isBase64) {
    try {
      text = Buffer.from(body, "base64").toString("utf-8")
    } catch {
      return null
    }
  } else {
    try {
      text = decodeURIComponent(body)
    } catch {
      // Not percent-encoded — use the raw body as-is. Common for
      // contracts that paste literal JSON after the comma.
      text = body
    }
  }

  try {
    const parsed = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Expand an `ipfs://` URI into a list of gateway URLs to race. Pass-through
 * for everything else.
 */
function expandIpfsUri(uri: string): string[] {
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "")
    return IPFS_GATEWAYS.map((g) => g + path)
  }
  return [uri]
}

/**
 * Rewrite the metadata's `image` field to something a browser `<img>` /
 * `next/image` can render directly. `data:` URLs and HTTPS URLs pass through
 * unchanged; `ipfs://` gets resolved through the first gateway.
 */
function resolveImageUri(uri: string): string {
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "")
    return IPFS_GATEWAYS[0] + path
  }
  return uri
}
