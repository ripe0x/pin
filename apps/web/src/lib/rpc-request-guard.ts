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
