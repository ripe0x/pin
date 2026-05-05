/**
 * Pure RPC + IPFS resolver for ERC-721 / ERC-1155 token metadata.
 *
 * No DB, no Next.js cache wrappers — just `(client, contract, tokenId)` →
 * `{ name?, description?, image? } | null`. Callers layer their own
 * persistence and dedup on top:
 *   - apps/web: `token_metadata` Postgres index + `unstable_cache` request
 *     dedup, both wrapped around this function.
 *   - apps/metadata-warmer: writes the same `token_metadata` rows from a
 *     long-lived sidecar so the web app's first-view path becomes a point
 *     lookup instead of an RPC + IPFS fetch.
 *
 * Both consumers depend on this single source of truth so URI parsing
 * edge cases (data: URIs from on-chain renderers, ERC-1155 `{id}`
 * substitution, IPFS gateway fallback) are fixed in one place.
 */
import type { Address, PublicClient } from "viem"
import { erc721Abi } from "@pin/abi"
import { extractCid, fetchFromIpfs } from "@pin/shared"

const erc1155UriAbi = [
  {
    type: "function",
    name: "uri",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
] as const

export type TokenMetadata = {
  name?: string
  description?: string
  image?: string
}

/**
 * Resolve metadata for a single token via RPC + IPFS. Tries ERC-721's
 * `tokenURI(id)` first; if that reverts (the contract is ERC-1155 or
 * doesn't implement the call), falls back to ERC-1155's `uri(id)`.
 * ERC-1155 URIs may contain a `{id}` placeholder per the spec which is
 * substituted with the lowercase hex token ID padded to 64 chars.
 *
 * Returns `null` when neither call returns a URI, the URI doesn't fetch,
 * or the response isn't parseable JSON. Callers that persist results
 * should still write a sentinel row so the next reader doesn't re-fetch.
 */
export async function resolveTokenMetadata(
  client: PublicClient,
  contractAddress: string,
  tokenId: string,
  options?: { fetchTimeoutMs?: number },
): Promise<TokenMetadata | null> {
  const id = BigInt(tokenId)
  const contract = contractAddress as Address
  const fetchTimeoutMs = options?.fetchTimeoutMs ?? 10_000

  const uriString = await client
    .readContract({
      address: contract,
      abi: erc721Abi,
      functionName: "tokenURI",
      args: [id],
    })
    .catch(() =>
      client
        .readContract({
          address: contract,
          abi: erc1155UriAbi,
          functionName: "uri",
          args: [id],
        })
        .catch(() => null),
    )

  if (!uriString) return null

  // ERC-1155 spec: substitute {id} with hex-padded token id (lowercase, 64 chars).
  const idHex = id.toString(16).padStart(64, "0")
  const resolvedUri = (uriString as string).replace(/\{id\}/g, idHex)

  // On-chain renderers (e.g. zorbs) return inline `data:application/json,…`
  // URIs. Don't hand these to fetch() — Node's fetch treats `#` as a URL
  // fragment delimiter and silently truncates the body, which trips on
  // common cases like `"name":"foo #2"`.
  if (resolvedUri.startsWith("data:")) {
    return parseDataUriJson(resolvedUri)
  }

  // Some metadata CDNs (Arweave gateway via CDN77) block bare server-side
  // fetches and serve an HTML error page. A standard browser UA + JSON
  // accept header gets through.
  const headers = {
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  }

  const cid = extractCid(resolvedUri)
  if (!cid) {
    try {
      const res = await fetch(resolvedUri, {
        signal: AbortSignal.timeout(fetchTimeoutMs),
        headers,
        cache: "no-store",
      })
      if (!res.ok) return null
      const contentType = res.headers.get("content-type") ?? ""
      if (!contentType.includes("json") && !contentType.includes("text/plain")) {
        return null
      }
      return (await res.json()) as TokenMetadata
    } catch {
      return null
    }
  }

  // IPFS URI — try each gateway in turn so one slow/timed-out gateway doesn't
  // result in `metadata: null` getting cached for 24h.
  try {
    const res = await fetchFromIpfs(cid, { headers, cache: "no-store" })
    const contentType = res.headers.get("content-type") ?? ""
    if (!contentType.includes("json") && !contentType.includes("text/plain")) {
      return null
    }
    return (await res.json()) as TokenMetadata
  } catch {
    return null
  }
}

/**
 * Parse a `data:` URI containing JSON metadata. Handles the common encodings:
 *   data:application/json,{...}
 *   data:application/json;utf8,{...}        ← Foundation's zorb contract
 *   data:application/json;charset=utf-8,{...}
 *   data:application/json;base64,<b64>
 * Body content is URL-decoded for the non-base64 forms.
 */
function parseDataUriJson(uri: string): TokenMetadata | null {
  const comma = uri.indexOf(",")
  if (comma < 0) return null
  const meta = uri.slice(5, comma) // strip "data:"
  const body = uri.slice(comma + 1)
  const isBase64 = /;\s*base64\b/i.test(meta)
  try {
    const decoded = isBase64
      ? Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body)
    return JSON.parse(decoded) as TokenMetadata
  } catch {
    // Some renderers emit unencoded JSON containing `%` characters that
    // decodeURIComponent rejects. Fall back to the raw body.
    if (!isBase64) {
      try {
        return JSON.parse(body) as TokenMetadata
      } catch {
        return null
      }
    }
    return null
  }
}
