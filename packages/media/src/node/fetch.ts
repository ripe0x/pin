import { lookup } from "node:dns/promises"
import http from "node:http"
import https from "node:https"
import { Readable } from "node:stream"
import { isIP } from "node:net"

export class UnsupportedMediaError extends Error {}

const DEFAULT_FETCH_TIMEOUT_MS = 20_000
const USER_AGENT = "pnd-media/1"

export function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) {
    return true
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  const v4 = mapped ?? (isIP(normalized) === 4 ? normalized : null)
  if (!v4) return false
  const [a, b] = v4.split(".").map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

export type PublicTarget = { url: URL; address: string; family: 4 | 6 }

/**
 * Validates scheme, credentials and host, resolves the host once, and
 * returns the address the connection must use. The same address is pinned
 * into the socket lookup in `requestPinned`, so a host cannot answer the
 * validation lookup with a public address and the connection lookup with a
 * private one.
 */
export async function resolvePublicHttpUrl(value: string): Promise<PublicTarget> {
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsupportedMediaError(`unsupported source scheme ${url.protocol}`)
  }
  if (url.username || url.password) throw new Error("credentialed media URL rejected")
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const literal = isIP(host)
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((row) => isPrivateIp(row.address))) {
    throw new Error("non-public media host rejected")
  }
  const chosen = addresses[0]
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 }
}

/**
 * One HTTP request to a validated target. The socket connects to the
 * pre-resolved address while TLS SNI and the Host header keep the original
 * hostname. Redirects are not followed here; `safeFetch` re-validates each
 * hop. The stream is exposed as a web Response so callers read it the same
 * way as fetch output.
 */
export function requestPinned(
  target: PublicTarget,
  init: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const { url, address, family } = target
  const client = url.protocol === "https:" ? https : http
  const headers: Record<string, string> = {
    accept: "*/*",
    "user-agent": USER_AGENT,
  }
  for (const [key, value] of Object.entries((init.headers as Record<string, string>) ?? {})) {
    headers[key.toLowerCase()] = value
  }
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers,
        servername: isIP(url.hostname) ? undefined : url.hostname,
        // net.connect asks for a list when autoSelectFamily is on; answer both
        // shapes with the one validated address.
        lookup: (_host, opts, cb) =>
          opts.all
            ? (cb as unknown as (e: null, r: Array<{ address: string; family: number }>) => void)(
                null,
                [{ address, family }],
              )
            : cb(null, address, family),
        timeout: timeoutMs,
      },
      (res) => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value)
        }
        const status = res.statusCode ?? 0
        const body =
          init.method === "HEAD" || status === 204 || status === 304
            ? null
            : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
        if (body === null) res.resume()
        resolve(new Response(body, { status, headers: responseHeaders }))
      },
    )
    req.on("timeout", () => req.destroy(new Error("media fetch timed out")))
    req.on("error", reject)
    req.end()
  })
}

export async function safeFetch(
  initialUrl: string,
  init: RequestInit,
  opts: { redirects?: number; timeoutMs?: number } = {},
): Promise<{ response: Response; url: string }> {
  const redirects = opts.redirects ?? 3
  let current = initialUrl
  for (let i = 0; i <= redirects; i++) {
    const target = await resolvePublicHttpUrl(current)
    const response = await requestPinned(target, init, opts.timeoutMs)
    if (response.status < 300 || response.status >= 400) {
      return { response, url: current }
    }
    const location = response.headers.get("location")
    await response.body?.cancel()
    if (!location || i === redirects) throw new Error("media redirect limit exceeded")
    current = new URL(location, current).toString()
  }
  throw new Error("media redirect limit exceeded")
}

export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? "0")
  if (length > limit) {
    await response.body?.cancel()
    throw new Error(`media exceeds ${limit} byte input ceiling`)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error(`media exceeds ${limit} byte input ceiling`)
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks, total)
}

export async function consumeProbePrefix(response: Response, limit: number): Promise<void> {
  if (!response.body) return
  const reader = response.body.getReader()
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Decode a `data:` URI, capping decoded size at `maxBytes`. */
export function decodeDataUri(uri: string, maxBytes: number): { bytes: Buffer; mime: string } {
  const comma = uri.indexOf(",")
  if (comma < 0) throw new UnsupportedMediaError("malformed data URI")
  const meta = uri.slice(5, comma)
  const mime = meta.split(";")[0].toLowerCase() || "application/octet-stream"
  const body = uri.slice(comma + 1)
  const bytes = /;base64(?:;|$)/i.test(meta)
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body))
  if (bytes.length > maxBytes) throw new Error("inline media exceeds input ceiling")
  return { bytes, mime }
}
