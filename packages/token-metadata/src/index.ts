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
import { lookup } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { isIP, type LookupFunction } from "node:net"
import { Readable } from "node:stream"
import {
  extractCid,
  fetchFromIpfs,
  extractIpnsPath,
  fetchFromIpns,
  extractArweavePath,
  fetchFromArweave,
} from "@pin/shared"

const MAX_METADATA_BYTES = 2 * 1024 * 1024
const MAX_HTTP_REDIRECTS = 3

const erc1155UriAbi = [
  {
    type: "function",
    name: "uri",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
] as const

// tokenURI plus the custom errors a token-no-longer-exists revert decodes
// to. Including the error fragments lets viem name the revert (so we can
// tell a burned token apart from an IPFS hiccup) directly from the
// `tokenURI` read — no extra `ownerOf` call. Covers OZ v5
// (`ERC721NonexistentToken`) and ERC721A
// (`URIQueryForNonexistentToken` / `OwnerQueryForNonexistentToken`).
const tokenUriAbi = [
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
  { type: "error", name: "ERC721NonexistentToken", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "URIQueryForNonexistentToken", inputs: [] },
  { type: "error", name: "OwnerQueryForNonexistentToken", inputs: [] },
] as const

// Revert signals that mean "this token does not exist on-chain" (burned or
// never minted). Matched against the decoded error name, the raw 4-byte
// selector in the revert data, and legacy string reverts (OZ < 5). All
// lowercased before comparison.
const NONEXISTENT_ERROR_NAMES = [
  "erc721nonexistenttoken",
  "uriqueryfornonexistenttoken",
  "ownerqueryfornonexistenttoken",
]
const NONEXISTENT_SELECTORS = [
  "0x7e273289", // ERC721NonexistentToken(uint256)
  "0xa14c4b50", // URIQueryForNonexistentToken()
  "0xceea21b6", // OwnerQueryForNonexistentToken()
]
const NONEXISTENT_STRINGS = [
  "nonexistent token", // "ERC721Metadata: URI query for nonexistent token", etc.
  "invalid token id", // OZ v4.8+: "ERC721: invalid token ID"
]

export type TokenMetadata = {
  name?: string
  description?: string
  image?: string
  /** Some metadata schemas embed a separate animation/video URL alongside
   * the still image. Token pages prefer this over `image` when present. */
  animation_url?: string
  /** The resolved tokenURI the metadata was fetched from (after `{id}`
   * substitution). Persisted as `raw_uri` so the UI can link to the
   * canonical source for verification. Omitted for inline `data:` URIs. */
  uri?: string
}

export type TokenMetadataResult = {
  metadata: TokenMetadata | null
  /**
   * Whether the token still exists on-chain, derived from the `tokenURI`
   * read:
   *  - `true`  — a URI resolved (token exists; `metadata` may still be null
   *              if the off-chain JSON didn't fetch — transient, not a burn).
   *  - `false` — definitive: `tokenURI` reverted with a nonexistent-token
   *              error (burned, or never minted).
   *  - `null`  — indeterminate (RPC error / unclassifiable revert). Callers
   *              must NOT flip a persisted burned flag on null.
   */
  exists: boolean | null
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
  return (
    await resolveTokenMetadataWithState(client, contractAddress, tokenId, options)
  ).metadata
}

/**
 * Same resolution as `resolveTokenMetadata`, but also reports whether the
 * token still EXISTS on-chain (see `TokenMetadataResult.exists`). The
 * existence signal falls out of the `tokenURI` call we already make, so
 * callers get burn detection without a separate `ownerOf` read — which is
 * what lets burned works be filtered from grids and 404'd on the token
 * page while honoring the project's RPC-minimization rule.
 */
export async function resolveTokenMetadataWithState(
  client: PublicClient,
  contractAddress: string,
  tokenId: string,
  options?: { fetchTimeoutMs?: number },
): Promise<TokenMetadataResult> {
  const id = BigInt(tokenId)
  const contract = contractAddress as Address
  const fetchTimeoutMs = options?.fetchTimeoutMs ?? 10_000

  const { uri, exists } = await readTokenUriWithState(client, contract, id)
  if (!uri) return { metadata: null, exists }

  // A URI resolved → the token exists, even if the off-chain JSON fails to
  // fetch below (transient gateway miss). Never downgrade to exists=false here.
  const metadata = await fetchMetadataForUri(uri, id, fetchTimeoutMs)
  return { metadata, exists: true }
}

/**
 * Acquire a token's metadata URI and classify existence in one pass. Tries
 * ERC-721 `tokenURI(id)`; a revert with a recognized nonexistent-token
 * error is a definitive burn (exists=false). Any OTHER tokenURI revert
 * means the contract is ERC-1155 or doesn't implement the call — fall back
 * to `uri(id)`. If both fail for an unclassifiable reason, existence is
 * indeterminate (null) and no burned flag should be written.
 */
async function readTokenUriWithState(
  client: PublicClient,
  contract: Address,
  id: bigint,
): Promise<{ uri: string | null; exists: boolean | null }> {
  try {
    const u = await client.readContract({
      address: contract,
      abi: tokenUriAbi,
      functionName: "tokenURI",
      args: [id],
    })
    return { uri: u as string, exists: true }
  } catch (err) {
    if (isNonexistentTokenError(err)) return { uri: null, exists: false }
    try {
      const u = await client.readContract({
        address: contract,
        abi: erc1155UriAbi,
        functionName: "uri",
        args: [id],
      })
      return { uri: u as string, exists: true }
    } catch {
      return { uri: null, exists: null }
    }
  }
}

/**
 * Fetch + parse the off-chain JSON behind an already-resolved tokenURI/uri
 * string. Exported (unlike the rest of this module's internals) for callers
 * that already have the raw tokenURI in hand from their own contract read
 * (e.g. a multicall that fetched `tokenURI` alongside other fields) and want
 * the same data:/IPFS/IPNS/HTTP parsing this module uses elsewhere, without
 * triggering a second on-chain `tokenURI` call via `resolveTokenMetadata`.
 * `id` is only used for the ERC-1155 `{id}` placeholder substitution; pass
 * the token id even for ERC-721 callers (harmless no-op when absent).
 */
export async function fetchMetadataForUri(
  uriString: string,
  id: bigint,
  fetchTimeoutMs = 10_000,
): Promise<TokenMetadata | null> {
  // ERC-1155 spec: substitute {id} with hex-padded token id (lowercase, 64 chars).
  const idHex = id.toString(16).padStart(64, "0")
  const resolvedUri = uriString.replace(/\{id\}/g, idHex)

  // On-chain renderers (e.g. zorbs) return inline `data:application/json,…`
  // URIs. Don't hand these to fetch() — Node's fetch treats `#` as a URL
  // fragment delimiter and silently truncates the body, which trips on
  // common cases like `"name":"foo #2"`.
  if (resolvedUri.startsWith("data:")) {
    if (Buffer.byteLength(resolvedUri, "utf8") > MAX_METADATA_BYTES) return null
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

  // IPNS URI — mutable name pointer. Node's fetch can't speak the `ipns:`
  // protocol, and extractCid won't find a CID, so route it through an
  // IPNS-capable gateway. The resolved JSON may itself embed `ipns://`
  // media URLs; those are converted at render time by `ipfsToHttp`.
  const ipnsPath = extractIpnsPath(resolvedUri)
  if (ipnsPath) {
    try {
      const res = await fetchFromIpns(ipnsPath, { headers, cache: "no-store" })
      const contentType = res.headers.get("content-type") ?? ""
      if (!contentType.includes("json") && !contentType.includes("text/plain")) {
        return null
      }
      return metadataOrNull(await readJsonWithinLimit(res), resolvedUri)
    } catch {
      return null
    }
  }

  // Arweave URI (`ar://` or an arweave.net gateway URL, including
  // path-manifest sub-paths like `<manifestId>/5`). arweave.net can 404 a
  // freshly-uploaded bundle for hours — even indefinitely, if the bundle was
  // served optimistically but never posted to L1 — while other ar.io gateways
  // that received the data already serve it. So try the gateway set in turn
  // rather than trusting arweave.net alone. `raw_uri` keeps the canonical
  // arweave.net URL regardless of which gateway actually served the bytes.
  const arweavePath = extractArweavePath(resolvedUri)
  if (arweavePath) {
    try {
      const res = await fetchFromArweave(arweavePath, {
        headers,
        cache: "no-store",
        timeoutMs: fetchTimeoutMs,
      })
      const contentType = res.headers.get("content-type") ?? ""
      if (!contentType.includes("json") && !contentType.includes("text/plain")) {
        return null
      }
      return metadataOrNull(await readJsonWithinLimit(res), resolvedUri)
    } catch {
      return null
    }
  }

  const cid = extractCid(resolvedUri)
  if (!cid) {
    try {
      const res = await fetchSafeHttpUrl(resolvedUri, fetchTimeoutMs, headers)
      if (!res.ok) return null
      const contentType = res.headers.get("content-type") ?? ""
      if (!contentType.includes("json") && !contentType.includes("text/plain")) {
        return null
      }
      return metadataOrNull(await readJsonWithinLimit(res), resolvedUri)
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
    return metadataOrNull(await readJsonWithinLimit(res), resolvedUri)
  } catch {
    return null
  }
}

async function fetchSafeHttpUrl(
  uri: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<Response> {
  let current = new URL(uri)

  for (let redirects = 0; redirects <= MAX_HTTP_REDIRECTS; redirects++) {
    const resolvedAddress = await assertSafePublicHttpsUrl(current)
    const res = resolvedAddress
      ? await fetchPinnedHttps(current, resolvedAddress, timeoutMs, headers)
      : await fetch(current, {
          signal: AbortSignal.timeout(timeoutMs),
          headers,
          cache: "no-store",
          redirect: "manual",
        })

    if (![301, 302, 303, 307, 308].includes(res.status)) return res
    const location = res.headers.get("location")
    if (!location || redirects === MAX_HTTP_REDIRECTS) {
      throw new Error("too many metadata redirects")
    }
    current = new URL(location, current)
  }

  throw new Error("too many metadata redirects")
}

type ResolvedAddress = { address: string; family: 4 | 6 }

async function assertSafePublicHttpsUrl(
  url: URL,
): Promise<ResolvedAddress | null> {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("unsafe metadata URL")
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("unsafe metadata host")
  }

  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error("unsafe metadata host")
    return null
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("unsafe metadata host")
  }
  // Pin the HTTPS connection to the address we validated. Resolving once and
  // then letting fetch resolve again would leave a DNS-rebinding window.
  return addresses[0] as ResolvedAddress
}

async function fetchPinnedHttps(
  url: URL,
  resolved: ResolvedAddress,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [resolved])
      } else {
        callback(null, resolved.address, resolved.family)
      }
    }

    const req = httpsRequest(
      url,
      {
        headers: { ...headers, "accept-encoding": "identity" },
        lookup: pinnedLookup,
        agent: false,
      },
      (incoming) => {
        const timer = setTimeout(
          () => incoming.destroy(new Error("metadata request timed out")),
          timeoutMs,
        )
        incoming.once("end", () => clearTimeout(timer))
        incoming.once("close", () => clearTimeout(timer))

        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item)
          } else if (value !== undefined) {
            responseHeaders.set(name, value)
          }
        }
        const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>
        resolve(
          new Response(body, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        )
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error("metadata request timed out")))
    req.once("error", reject)
    req.end()
  })
}

function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length)
    const hex = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hex) {
      const high = Number.parseInt(hex[1], 16)
      const low = Number.parseInt(hex[2], 16)
      return isPublicIp(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
      )
    }
    return isPublicIp(mapped)
  }

  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split(".").map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
  }

  if (isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1") return false
    if (/^f[cd]/.test(normalized) || normalized.startsWith("fe")) return false
    if (
      normalized.startsWith("ff") ||
      normalized.startsWith("64:ff9b:") ||
      normalized.startsWith("2001:db8:")
    ) {
      return false
    }
    return true
  }

  return false
}

async function readJsonWithinLimit(res: Response): Promise<unknown> {
  const declaredLength = Number(res.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) {
    throw new Error("metadata response too large")
  }
  if (!res.body) throw new Error("metadata response is empty")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_METADATA_BYTES) {
      await reader.cancel()
      throw new Error("metadata response too large")
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return JSON.parse(text) as unknown
}

/**
 * Accept a fetched body as token metadata only if it actually carries a
 * recognizable field (name / description / image / animation_url).
 *
 * A 200 response can still be useless: a gateway rate-limit/error page served
 * as JSON, an empty object, or a directory listing all parse fine but contain
 * none of these. Treating those as "resolved" (and stamping `uri`/`raw_uri`)
 * is what made tokens stick on a blank placeholder forever — callers key
 * "did this resolve?" off content presence, so a content-less object must be
 * a miss (null), not a success.
 */
function metadataOrNull(json: unknown, uri: string): TokenMetadata | null {
  if (!json || typeof json !== "object") return null
  const m = json as Record<string, unknown>
  const has = (v: unknown): boolean => typeof v === "string" && v.length > 0
  if (!has(m.name) && !has(m.description) && !has(m.image) && !has(m.animation_url)) {
    return null
  }
  return { ...(m as TokenMetadata), uri }
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

/**
 * Does this viem error mean "the token does not exist on-chain" (burned or
 * never minted), as opposed to a transient RPC failure or an unrelated
 * revert? We check three independent signals because providers surface the
 * revert differently: the viem-decoded error name (when the ABI carries the
 * error fragment), the raw 4-byte selector embedded in the revert data, and
 * legacy string reverts from pre-custom-error contracts. Conservative by
 * design — returns true ONLY on a positive match, so a renderer failure or
 * a generic revert never gets misclassified as a burn.
 */
function isNonexistentTokenError(err: unknown): boolean {
  const parts: string[] = []
  let cur: unknown = err
  let depth = 0
  while (cur && depth < 8) {
    if (typeof cur === "string") {
      parts.push(cur)
      break
    }
    if (typeof cur === "object") {
      const o = cur as Record<string, unknown>
      for (const k of ["message", "shortMessage", "details", "reason", "signature"]) {
        if (typeof o[k] === "string") parts.push(o[k] as string)
      }
      if (Array.isArray(o.metaMessages)) {
        for (const m of o.metaMessages) if (typeof m === "string") parts.push(m)
      }
      // viem ContractFunctionRevertedError: decoded name + raw data live under `.data`.
      const data = o.data as { errorName?: unknown; data?: unknown } | string | undefined
      if (typeof data === "string") parts.push(data)
      else if (data && typeof data === "object") {
        if (typeof data.errorName === "string") parts.push(data.errorName)
        if (typeof data.data === "string") parts.push(data.data)
      }
      cur = o.cause
    } else {
      break
    }
    depth++
  }
  const hay = parts.join("  ").toLowerCase()
  return (
    NONEXISTENT_ERROR_NAMES.some((n) => hay.includes(n)) ||
    NONEXISTENT_SELECTORS.some((s) => hay.includes(s)) ||
    NONEXISTENT_STRINGS.some((s) => hay.includes(s))
  )
}
