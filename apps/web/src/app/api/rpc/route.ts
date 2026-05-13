import { NextRequest, NextResponse } from "next/server"
import { getClientIp } from "@/lib/rate-limit"
import {
  hashIp,
  logRpcEvent,
  refererPathname,
  upstreamHost,
} from "@/lib/rpc-log"

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
const INFURA_API_KEY = process.env.INFURA_API_KEY

// Upstream chain: try Alchemy first, then Infura, then fall through to
// public RPCs. Each fallback supports the standard JSON-RPC method set
// including `eth_sendRawTransaction`, so a mint/bid still goes through
// even when the primary is unhealthy. Order matters — earliest entries
// are tried first.
//
// Infura's free tier intermittently caps `eth_getLogs` to a 10-block range
// and returns an "Under the Free tier plan..." JSON-RPC error. The body
// matcher in `tryUpstream` below detects that response and treats it as a
// transient failure so the proxy falls through to the next upstream — that
// way Infura remains a useful authenticated backup for every other method
// (eth_call, eth_estimateGas, eth_blockNumber, …) while wide log scans
// gracefully skip past it to a public RPC without the cap.
//
// The publicnode endpoint accepts an optional API key; we use the anonymous
// tier. drpc/llamarpc/cloudflare are all anonymous public mainnet RPCs.
const UPSTREAMS = [
  ALCHEMY_API_KEY
    ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
    : null,
  INFURA_API_KEY
    ? `https://mainnet.infura.io/v3/${INFURA_API_KEY}`
    : null,
  "https://eth.llamarpc.com",
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://rpc.ankr.com/eth",
  "https://cloudflare-eth.com",
  "https://1rpc.io/eth",
].filter((u): u is string => typeof u === "string")

// Per-upstream timeout. Public RPCs occasionally hang; bail fast and try the
// next one rather than letting the wallet wait the full Vercel function
// budget.
const UPSTREAM_TIMEOUT_MS = 6_000

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

async function tryUpstream(
  url: string,
  payload: string,
): Promise<{ ok: true; status: number; text: string } | { ok: false }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      cache: "no-store",
      signal: ctrl.signal,
    })
    // 5xx and 429 mean the upstream is unhealthy / rate-limiting us; fall
    // through to the next one. 4xx other than 429 usually means the request
    // itself is bad — surfacing that to the client is more useful than
    // pretending another RPC will accept it, so we treat those as success.
    if (res.status >= 500 || res.status === 429) {
      return { ok: false }
    }
    const text = await res.text()
    // Some public RPCs return 200 with a JSON-RPC error like "internal
    // error" or "method handler crashed" instead of a proper 5xx. If the
    // body parses as an RPC error and the code looks transient, fall
    // through. Don't fall through on legitimate -32601 (method not found)
    // for write methods etc., since the next public RPC is unlikely to
    // accept them either; just on -32603 (internal error) and -32005
    // (limit exceeded), which signal upstream-side failure.
    //
    // We also detect Infura's free-tier rejection by body text rather
    // than error code — Infura piggybacks on the standard -32600
    // ("Invalid Request") code for what is functionally a quota cap, so
    // matching on the human-readable hint ("Free tier" / "block range")
    // is the only way to tell a genuine bad request apart from a
    // capacity rejection. Worst case if the wording changes: we see it
    // once and add another pattern.
    try {
      const parsed: unknown = JSON.parse(text)
      const entries = Array.isArray(parsed) ? parsed : [parsed]
      const transient = entries.some((e) => {
        if (!e || typeof e !== "object") return false
        const err = (e as {
          error?: { code?: number; message?: string; data?: unknown }
        }).error
        if (!err) return false
        if (err.code === -32603 || err.code === -32005) return true
        const hint = `${err.message ?? ""} ${
          typeof err.data === "string" ? err.data : JSON.stringify(err.data ?? "")
        }`
        if (/free tier|block range/i.test(hint)) return true
        return false
      })
      if (transient) return { ok: false }
    } catch {
      // not JSON — let it through as-is
    }
    return { ok: true, status: res.status, text }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

export async function POST(req: NextRequest) {
  if (UPSTREAMS.length === 0) {
    return NextResponse.json(
      { error: "no upstream RPC configured on server" },
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
  const payload = JSON.stringify(body)

  // Walk the full upstream chain for every request. The configured primary
  // (Alchemy → Infura) serves every healthy read, keeping wallet+query
  // patterns off public RPCs on the happy path. The public fallbacks only
  // see traffic when every preferred upstream is down — a tradeoff against
  // the previous design, where a single primary hiccup took the entire
  // read path down site-wide.
  const upstreams = UPSTREAMS

  // Log one event per request, attributed to the first batch entry's
  // method. Batches are typically 1–2 entries; if we ever need precise
  // per-method volume in batches we'd add a `batch_size` column.
  const logMethod = batch[0]?.method ?? "unknown"
  const referer = refererPathname(req.headers.get("referer"))
  const ipHash = hashIp(ip)
  const t0 = Date.now()

  for (const url of upstreams) {
    const result = await tryUpstream(url, payload)
    if (result.ok) {
      logRpcEvent({
        source: "proxy",
        method: logMethod,
        referer,
        ipHash,
        durationMs: Date.now() - t0,
        status: result.status,
        upstream: upstreamHost(url),
        ok: true,
      })
      return new NextResponse(result.text, {
        status: result.status,
        headers: { "content-type": "application/json" },
      })
    }
  }

  logRpcEvent({
    source: "proxy",
    method: logMethod,
    referer,
    ipHash,
    durationMs: Date.now() - t0,
    status: 502,
    upstream: null,
    ok: false,
  })
  return NextResponse.json(
    { error: "all upstream RPCs failed" },
    { status: 502 },
  )
}
