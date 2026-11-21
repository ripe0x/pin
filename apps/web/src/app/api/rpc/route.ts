import { NextRequest, NextResponse } from "next/server"
import { getClientIp, rateLimit } from "@/lib/rate-limit"
import {
  hashIp,
  logRpcEvent,
  refererPathname,
  upstreamHost,
} from "@/lib/rpc-log"
import {
  attemptTimeoutMs,
  checkRpcEntry,
  isAllowedRpcOrigin,
  MAX_RPC_BATCH_SIZE,
  mergeBatchResponses,
  readRpcBodyWithinLimit,
  rpcErrorResponse,
  selectUpstreams,
  type JsonRpcErrorResponse,
  type JsonRpcRequest,
  type RpcUpstream,
} from "@/lib/rpc-request-guard"

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
 *   - Same-origin POST. The browser's `Origin` (or, failing that, `Referer`)
 *     must name this site's own host, so other sites cannot use their
 *     visitors' browsers as a distributed relay. Non-browser clients can
 *     forge the header; the per-IP limit is what bounds those.
 *   - Per-IP rate limit (RPS budget below), shared across instances through
 *     lib/rate-limit.ts. Real users only need a few RPC calls per page; the
 *     limit is well above that.
 *   - Method allowlist, eth_getLogs span limit, and an eth_call /
 *     eth_estimateGas gas ceiling (lib/rpc-request-guard.ts).
 *   - eth_getLogs never reaches the paid backstops, and the whole fallback
 *     walk runs under one overall deadline.
 *
 * Out of scope: write protection. The user is going to broadcast their own
 * signed transactions via `eth_sendRawTransaction` either way; we just route
 * the bytes. Alchemy fee/gas methods are also allowed since wagmi's writeContract
 * pipeline calls them.
 */

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY
const INFURA_API_KEY = process.env.INFURA_API_KEY

// Upstream chain: Tenderly's public gateway leads, then other anonymous
// public RPCs, with Alchemy/Infura demoted to last-resort backstops (only
// present when their key is set). Each upstream supports the standard
// JSON-RPC method set including `eth_sendRawTransaction`, so a mint/bid
// still goes through when an earlier one is unhealthy. Order matters —
// earliest entries are tried first; the fallback rotates on failure, so a
// capped or rate-limited provider doesn't stall the wallet. Leading with
// the public tier spares paid Alchemy quota for the case every public
// provider is failing at once.
//
// Infura's free tier intermittently caps `eth_getLogs` to a 10-block range
// and returns an "Under the Free tier plan..." JSON-RPC error. The body
// matcher in `tryUpstream` below detects that response and treats it as a
// transient failure so the proxy falls through to the next upstream — that
// way Infura remains a useful authenticated backup for every other method
// (eth_call, eth_estimateGas, eth_blockNumber, …) while wide log scans
// gracefully skip past it. (eth_getLogs is now kept off both paid entries
// entirely, see selectUpstreams in lib/rpc-request-guard.ts.)
//
// The publicnode endpoint accepts an optional API key; we use the anonymous
// tier. tenderly/drpc/cloudflare/1rpc are all anonymous public mainnet RPCs.
const UPSTREAMS: RpcUpstream[] = [
  { url: "https://gateway.tenderly.co/public/mainnet", paid: false },
  { url: "https://ethereum-rpc.publicnode.com", paid: false },
  { url: "https://eth.drpc.org", paid: false },
  { url: "https://cloudflare-eth.com", paid: false },
  { url: "https://1rpc.io/eth", paid: false },
  ALCHEMY_API_KEY
    ? { url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`, paid: true }
    : null,
  INFURA_API_KEY ? { url: `https://mainnet.infura.io/v3/${INFURA_API_KEY}`, paid: true } : null,
].filter((u): u is RpcUpstream => u !== null)

// Per-upstream timeout. Public RPCs occasionally hang; bail fast and try the
// next one rather than letting the wallet wait the full Vercel function
// budget.
const UPSTREAM_TIMEOUT_MS = 6_000

// Overall budget for one request across every fallback attempt, kept under
// the serverless function timeout.
const OVERALL_DEADLINE_MS = 20_000

// Origins besides the request's own host that may call this route (the
// canonical site and the deploy's configured URLs).
const EXTRA_ALLOWED_ORIGINS = [
  "https://pnd.fyi",
  process.env.NEXT_PUBLIC_SITE_URL,
  process.env.URL,
  process.env.DEPLOY_PRIME_URL,
].filter((u): u is string => typeof u === "string" && u.length > 0)

// Rate limit: per-IP RPC operations per minute. A batch is charged by its
// number of entries, so batching improves latency without multiplying quota.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_PER_WINDOW = 240 // 4 rps sustained

async function tryUpstream(
  url: string,
  payload: string,
  timeoutMs: number,
): Promise<{ ok: true; status: number; text: string } | { ok: false }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
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

function jsonRpc(body: unknown) {
  // JSON-RPC errors are always 200 at the HTTP layer.
  return NextResponse.json(body, { status: 200 })
}

export async function POST(req: NextRequest) {
  if (UPSTREAMS.length === 0) {
    return NextResponse.json(
      { error: "no upstream RPC configured on server" },
      { status: 500 },
    )
  }

  if (
    !isAllowedRpcOrigin({
      origin: req.headers.get("origin"),
      referer: req.headers.get("referer"),
      host: req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
      allowedOrigins: EXTRA_ALLOWED_ORIGINS,
    })
  ) {
    return NextResponse.json({ error: "cross-origin requests are not allowed" }, { status: 403 })
  }

  let body: JsonRpcRequest | JsonRpcRequest[]
  try {
    const rawBody = await readRpcBodyWithinLimit(req)
    body = JSON.parse(rawBody) as JsonRpcRequest | JsonRpcRequest[]
  } catch (err) {
    if (err instanceof Error && err.message === "request body too large") {
      return NextResponse.json({ error: err.message }, { status: 413 })
    }
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }

  // viem batches requests as an array; check every entry.
  const isBatch = Array.isArray(body)
  const batch: unknown[] = isBatch ? (body as unknown[]) : [body]
  if (batch.length === 0) {
    return jsonRpc(rpcErrorResponse(null, -32600, "empty batches are not allowed"))
  }
  if (batch.length > MAX_RPC_BATCH_SIZE) {
    return NextResponse.json(
      { error: `batch exceeds ${MAX_RPC_BATCH_SIZE} operations` },
      { status: 413 },
    )
  }

  // Invalid entries get their own JSON-RPC error in the response; the rest
  // are forwarded. A single (non-batch) request answers with its error.
  const valid: (JsonRpcRequest & { method: string })[] = []
  const errors: JsonRpcErrorResponse[] = []
  for (const entry of batch) {
    const check = checkRpcEntry(entry)
    if (check.ok) valid.push(check.entry)
    else errors.push(check.error)
  }
  if (!isBatch && errors.length > 0) return jsonRpc(errors[0])
  if (valid.length === 0) return jsonRpc(errors)

  // A batch consumes one limiter unit per forwarded operation, closing the
  // loophole where many RPC calls could be hidden in one HTTP request.
  const ip = getClientIp(req)
  const rl = await rateLimit(req, {
    namespace: "rpc",
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX_PER_WINDOW,
    cost: valid.length,
  })
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  // Re-encode only the validated request objects. JSON-RPC does not attach
  // meaning to key ordering or whitespace.
  const payload = JSON.stringify(isBatch ? valid : valid[0])

  // Walk the public-first upstream chain; paid providers are last-resort
  // backstops, and never serve log scans.
  const upstreams = selectUpstreams(
    UPSTREAMS,
    valid.map((e) => e.method),
  )

  // Log one event per request, attributed to the first forwarded entry's
  // method. Batches are typically 1–2 entries; if we ever need precise
  // per-method volume in batches we'd add a `batch_size` column.
  const logMethod = valid[0]?.method ?? "unknown"
  const referer = refererPathname(req.headers.get("referer"))
  const ipHash = hashIp(ip)
  const t0 = Date.now()
  const deadline = t0 + OVERALL_DEADLINE_MS

  for (const upstream of upstreams) {
    const timeoutMs = attemptTimeoutMs(UPSTREAM_TIMEOUT_MS, deadline, Date.now())
    if (timeoutMs === 0) break
    const result = await tryUpstream(upstream.url, payload, timeoutMs)
    if (result.ok) {
      logRpcEvent({
        source: "proxy",
        method: logMethod,
        referer,
        ipHash,
        durationMs: Date.now() - t0,
        status: result.status,
        upstream: upstreamHost(upstream.url),
        ok: true,
      })
      if (errors.length === 0) {
        return new NextResponse(result.text, {
          status: result.status,
          headers: { "content-type": "application/json" },
        })
      }
      const merged = mergeBatchResponses(errors, result.text)
      if (merged) return jsonRpc(merged)
      return jsonRpc([
        ...errors,
        ...valid.map((e) => rpcErrorResponse(e.id, -32603, "upstream returned an invalid batch")),
      ])
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
