import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export const MAX_METADATA_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3
const DNS_CACHE_MS = 60_000
const DNS_CACHE_LIMIT = 128

const dnsCache = new Map<
  string,
  { expiresAt: number; addresses: string[] }
>()

/** True only for globally routable addresses. */
export function isPublicNetworkAddress(rawAddress: string): boolean {
  const address = rawAddress.replace(/^\[|\]$/g, "").toLowerCase()
  const version = isIP(address)
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
  }
  if (version === 6) {
    if (address === "::" || address === "::1") return false
    if (address.startsWith("::ffff:")) {
      return isPublicNetworkAddress(address.slice("::ffff:".length))
    }
    if (address.startsWith("fc") || address.startsWith("fd")) return false
    if (/^fe[89ab]/.test(address)) return false
    if (address.startsWith("ff") || address.startsWith("2001:db8")) return false
    return true
  }
  return false
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  )
}

async function publicAddressesFor(hostname: string): Promise<string[]> {
  const cached = dnsCache.get(hostname)
  if (cached && cached.expiresAt > Date.now()) return cached.addresses

  const records = await lookup(hostname, { all: true, verbatim: true })
  const addresses = records.map((record) => record.address)
  if (dnsCache.size >= DNS_CACHE_LIMIT) dnsCache.clear()
  dnsCache.set(hostname, {
    expiresAt: Date.now() + DNS_CACHE_MS,
    addresses,
  })
  return addresses
}

/**
 * Validate an NFT-controlled URL before the server requests it. Redirects
 * are validated separately by safeFetchText, so a public URL cannot bounce
 * into localhost, a private VPC address, or a cloud metadata endpoint.
 */
export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error("metadata URL is invalid")
  }
  if (url.protocol !== "https:") {
    throw new Error("metadata URL must use HTTPS")
  }
  if (url.username || url.password || isBlockedHostname(url.hostname)) {
    throw new Error("metadata URL host is not allowed")
  }

  const literalVersion = isIP(url.hostname.replace(/^\[|\]$/g, ""))
  const addresses = literalVersion
    ? [url.hostname]
    : await publicAddressesFor(url.hostname)
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicNetworkAddress(address))
  ) {
    throw new Error("metadata URL resolves to a non-public address")
  }
  return url
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("metadata response is too large")
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error("metadata response is too large")
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export async function safeFetchText(
  rawUrl: string,
  signal: AbortSignal,
  maxBytes = MAX_METADATA_BYTES,
): Promise<string> {
  let current = await assertSafeRemoteUrl(rawUrl)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const response = await fetch(current, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal,
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location || redirect === MAX_REDIRECTS) {
        throw new Error("metadata redirect could not be followed safely")
      }
      current = await assertSafeRemoteUrl(new URL(location, current).toString())
      continue
    }
    if (!response.ok) {
      throw new Error(`fetch ${current.toString()} -> ${response.status}`)
    }
    return readBoundedText(response, maxBytes)
  }
  throw new Error("too many metadata redirects")
}
