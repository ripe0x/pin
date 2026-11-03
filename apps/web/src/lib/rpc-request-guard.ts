export const MAX_RPC_REQUEST_BODY_BYTES = 64 * 1024
export const MAX_RPC_BATCH_SIZE = 20
export const MAX_GET_LOGS_BLOCK_SPAN = 10_000n

export type JsonRpcRequest = {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
}

export async function readRpcBodyWithinLimit(req: Request): Promise<string> {
  const declaredLength = Number(req.headers.get("content-length"))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RPC_REQUEST_BODY_BYTES
  ) {
    throw new Error("request body too large")
  }

  if (!req.body) return ""
  const reader = req.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RPC_REQUEST_BODY_BYTES) {
      await reader.cancel()
      throw new Error("request body too large")
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function parseBlockQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null
  return BigInt(value)
}

export function getLogsValidationError(params: unknown): string | null {
  if (!Array.isArray(params) || !params[0] || typeof params[0] !== "object") {
    return "eth_getLogs requires a filter object"
  }

  const filter = params[0] as Record<string, unknown>
  if (typeof filter.blockHash === "string") return null

  const { fromBlock, toBlock } = filter
  // Omitted bounds both default to `latest`, which is a single-block query.
  if (fromBlock === undefined && toBlock === undefined) return null
  if (
    (fromBlock === "latest" ||
      fromBlock === "safe" ||
      fromBlock === "finalized") &&
    (toBlock === undefined || toBlock === fromBlock)
  ) {
    return null
  }

  const from = parseBlockQuantity(fromBlock)
  const to = parseBlockQuantity(toBlock)
  if (from === null || to === null || to < from) {
    return "eth_getLogs requires explicit numeric bounds"
  }
  if (to - from > MAX_GET_LOGS_BLOCK_SPAN) {
    return `eth_getLogs range exceeds ${MAX_GET_LOGS_BLOCK_SPAN} blocks`
  }
  return null
}

/** Highest `gas` an eth_call / eth_estimateGas may name. Browser reads on
 *  this site never set one (the heavy tokenURI reads run server-side with
 *  their own clients), and a transaction cannot use more than a block. */
export const MAX_RPC_CALL_GAS = 50_000_000n

// Methods viem + wagmi + RainbowKit call. Anything else is rejected. Keep
// this list tight; widen only when something legitimate breaks.
export const ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set([
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
  // Transactions (signed bytes only, the server never signs)
  "eth_sendRawTransaction",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
])

/** `gas` above MAX_RPC_CALL_GAS on a call-shaped request, or a malformed one. */
export function gasCapError(method: string, params: unknown): string | null {
  if (method !== "eth_call" && method !== "eth_estimateGas") return null
  if (!Array.isArray(params) || !params[0] || typeof params[0] !== "object") return null
  const gas = (params[0] as Record<string, unknown>).gas
  if (gas === undefined || gas === null) return null
  const parsed = parseBlockQuantity(gas)
  if (parsed === null) return "gas must be a hex quantity"
  if (parsed > MAX_RPC_CALL_GAS) return `gas exceeds ${MAX_RPC_CALL_GAS}`
  return null
}

export type JsonRpcErrorResponse = {
  jsonrpc: "2.0"
  id: number | string | null
  error: { code: number; message: string }
}

export type RpcEntryCheck =
  | { ok: true; entry: JsonRpcRequest & { method: string } }
  | { ok: false; error: JsonRpcErrorResponse }

export function rpcErrorResponse(id: unknown, code: number, message: string): JsonRpcErrorResponse {
  const safeId = typeof id === "number" || typeof id === "string" ? id : null
  return { jsonrpc: "2.0", id: safeId, error: { code, message } }
}

/** Validate one JSON-RPC entry: shape, method allowlist, getLogs range, gas cap. */
export function checkRpcEntry(entry: unknown): RpcEntryCheck {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, error: rpcErrorResponse(null, -32600, "invalid JSON-RPC request") }
  }
  const e = entry as JsonRpcRequest
  const method = e.method
  if (typeof method !== "string" || !ALLOWED_RPC_METHODS.has(method)) {
    return {
      ok: false,
      error: rpcErrorResponse(e.id, -32601, `Method not allowed: ${String(method).slice(0, 64)}`),
    }
  }
  if (method === "eth_getLogs") {
    const err = getLogsValidationError(e.params)
    if (err) return { ok: false, error: rpcErrorResponse(e.id, -32600, err) }
  }
  const gasErr = gasCapError(method, e.params)
  if (gasErr) return { ok: false, error: rpcErrorResponse(e.id, -32602, gasErr) }
  return { ok: true, entry: e as JsonRpcRequest & { method: string } }
}

export type RpcUpstream = { url: string; paid: boolean }

/** Upstreams eligible for a request. Log scans stay on the anonymous public
 *  tier: they are the costliest method on metered providers. */
export function selectUpstreams(
  upstreams: readonly RpcUpstream[],
  methods: readonly string[],
): RpcUpstream[] {
  if (methods.includes("eth_getLogs")) return upstreams.filter((u) => !u.paid)
  return [...upstreams]
}

/**
 * Browser-origin check. A POST from a page on this site always carries an
 * `Origin` header naming this site; a page on another site carries its own.
 * Requests with no Origin fall back to Referer, and are refused when neither
 * names an allowed host (server-side code in this app calls its upstream
 * directly, never through this route).
 */
export function isAllowedRpcOrigin(input: {
  origin: string | null
  referer: string | null
  host: string | null
  allowedOrigins?: readonly string[]
}): boolean {
  const allowedHosts = new Set<string>()
  if (input.host) allowedHosts.add(input.host.toLowerCase())
  for (const o of input.allowedOrigins ?? []) {
    const h = hostOf(o)
    if (h) allowedHosts.add(h)
  }
  const claimed = input.origin && input.origin !== "null" ? input.origin : input.referer
  if (!claimed) return false
  const h = hostOf(claimed)
  return h !== null && allowedHosts.has(h)
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    return u.host.toLowerCase()
  } catch {
    return null
  }
}

/** Per-attempt timeout under an overall deadline; 0 means no time left. */
export function attemptTimeoutMs(perAttemptMs: number, deadline: number, now: number): number {
  const remaining = deadline - now
  if (remaining < 250) return 0
  return Math.min(perAttemptMs, remaining)
}

/**
 * Merge per-entry validation errors with the upstream's answer for the
 * entries that were forwarded, so a batch caller gets one response per
 * request entry. `upstreamText` is the upstream body for the forwarded
 * subset (always sent as an array). Returns null when that body is not a
 * JSON array, so the caller can fail the forwarded entries instead.
 */
export function mergeBatchResponses(
  errors: readonly JsonRpcErrorResponse[],
  upstreamText: string | null,
): unknown[] | null {
  if (upstreamText === null) return [...errors]
  try {
    const parsed: unknown = JSON.parse(upstreamText)
    if (!Array.isArray(parsed)) return null
    return [...errors, ...parsed]
  } catch {
    return null
  }
}
