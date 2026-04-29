import { NextRequest, NextResponse } from "next/server"

/**
 * Server-side JSON-RPC proxy for the public Alchemy mainnet endpoint.
 *
 * Why this exists: when we configured the wagmi/viem transport with
 * `process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL`, the API key was inlined into
 * the client bundle and visible to every visitor. Anyone could scrape the
 * key and burn through our monthly Alchemy CU cap. This route forwards
 * JSON-RPC bodies server-side using a non-public secret, so the key never
 * reaches the browser, and gives us a single place to enforce a method
 * allowlist + per-IP rate limit.
 *
 * Auth model:
 *   - Public POST. Anyone can hit `/api/rpc` and have it forwarded.
 *   - Per-IP rate limit (RPS budget below) keeps casual abuse from running up
 *     the bill. Real users only need a few RPC calls per page; the limit is
 *     well above that.
 *   - Method allowlist rejects anything outside the standard read/write set
 *     viem/wagmi actually use.
 *
 * Out of scope: write protection. The user is going to broadcast their own
 * signed transactions via `eth_sendRawTransaction` either way; we just route
 * the bytes. Alchemy fee/gas methods are also allowed since wagmi's writeContract
 * pipeline calls them.
 */

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY
const UPSTREAM = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY ?? ""}`

// Methods we expect viem + wagmi + RainbowKit to call. Anything else gets
// rejected. Keep this list tight; widen only when something legitimate breaks.
const ALLOWED_METHODS = new Set([
  // Read state
  "eth_call",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getLogs",
  // Block / chain metadata
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_chainId",
  "net_version",
  // Gas / fees
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_estimateGas",
  // Transactions (signed bytes only — we never sign on the server)
  "eth_sendRawTransaction",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
])

// Rate limit: per-IP token bucket of RPC calls per minute. Real users average
// well under this; the limit is sized to give a moderate-traffic page room
// without giving a scraper a meaningful budget.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_PER_WINDOW = 240 // 4 rps sustained

// Persist counts across HMR reloads. Per-instance on Vercel; an attacker
// rotating regions buys themselves a small amount of extra budget but can't
// run unbounded.
type Counter = { count: number; windowStart: number }
const counts: Map<string, Counter> = (
  globalThis as unknown as { __pndRpcLimiter?: Map<string, Counter> }
).__pndRpcLimiter ??
  ((
    globalThis as unknown as { __pndRpcLimiter?: Map<string, Counter> }
  ).__pndRpcLimiter = new Map())

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return req.headers.get("x-real-ip") ?? "unknown"
}

function rateLimit(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()

  // Opportunistic cleanup so the map doesn't grow without bound.
  if (counts.size > 5000) {
    for (const [k, c] of counts) {
      if (now - c.windowStart > RATE_LIMIT_WINDOW_MS) counts.delete(k)
    }
  }

  const c = counts.get(ip)
  if (!c || now - c.windowStart > RATE_LIMIT_WINDOW_MS) {
    counts.set(ip, { count: 1, windowStart: now })
    return { ok: true }
  }
  if (c.count >= RATE_LIMIT_MAX_PER_WINDOW) {
    const retryAfter = Math.ceil(
      (RATE_LIMIT_WINDOW_MS - (now - c.windowStart)) / 1000,
    )
    return { ok: false, retryAfter }
  }
  c.count++
  return { ok: true }
}

type JsonRpcRequest = {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
}

function rejectMethod(id: number | string | null | undefined, method: string) {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32601, message: `Method not allowed: ${method}` },
    },
    { status: 200 }, // JSON-RPC errors are always 200 at the HTTP layer.
  )
}

export async function POST(req: NextRequest) {
  if (!ALCHEMY_API_KEY) {
    return NextResponse.json(
      { error: "ALCHEMY_API_KEY env var not configured on server" },
      { status: 500 },
    )
  }

  const ip = getClientIp(req)
  const rl = rateLimit(ip)
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  let body: JsonRpcRequest | JsonRpcRequest[]
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }

  // viem batches requests as an array; check every entry.
  const batch = Array.isArray(body) ? body : [body]
  for (const entry of batch) {
    const method = entry?.method
    if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
      return rejectMethod(entry?.id ?? null, String(method))
    }
  }

  // Forward verbatim. We pass the original body bytes through so encoding
  // matches exactly what viem sent (including key ordering, etc.).
  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // Don't let Next cache RPC responses — they're highly variable and the
    // upstream is already fast.
    cache: "no-store",
  })

  // Pass the upstream body and status straight through. Strip headers we
  // don't want to leak (e.g., upstream rate-limit headers that would confuse
  // viem's retry).
  const text = await upstream.text()
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  })
}
