export type MediaKind = "image" | "video" | "animation" | "unknown"
export type MediaStatus = "pending" | "ready" | "unsupported" | "failed"

/**
 * Delivery state for one token's media: the probed source plus, once
 * derived, the disposable thumbnail or poster. Canonical art stays at
 * `sourceUrl`; every other field describes the derivative cache entry.
 * Timestamps are ISO 8601 strings so a record serializes into a manifest
 * or a database row without a Date type at the boundary.
 */
export type MediaRecord = {
  contract: string
  tokenId: string
  sourceUrl: string
  resolvedUrl: string | null
  kind: MediaKind
  status: MediaStatus
  thumbnailUrl: string | null
  posterUrl: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  mimeType: string | null
  sourceBytes: number | null
  derivativeBytes: number | null
  sourceSha256: string | null
  derivativeSha256: string | null
  preferredGateway: string | null
  attemptCount: number
  lastError: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  nextAttemptAt: string | null
}

/** Key a record by contract and token id: `${lowercase contract}:${tokenId}`. */
export function recordKey(contract: string, tokenId: string): string {
  return `${contract.toLowerCase()}:${tokenId}`
}
