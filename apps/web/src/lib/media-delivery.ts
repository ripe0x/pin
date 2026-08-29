import "server-only"
import { sql } from "./db"

export type MediaDeliveryStatus = "pending" | "ready" | "unsupported" | "failed"

export type MediaDelivery = {
  status: MediaDeliveryStatus
  kind: "image" | "video" | "animation" | "unknown"
  originalUrl: string
  resolvedUrl: string | null
  thumbnailUrl: string | null
  posterUrl: string | null
  width: number | null
  height: number | null
  mimeType: string | null
  sourceBytes: number | null
  derivativeBytes: number | null
  sha256: string | null
  attempts: number
  lastError: string | null
  nextAttemptAt: string | null
}
export async function getMediaDeliveries(
  refs: readonly { contract: string; tokenId: string }[],
): Promise<Map<string, MediaDelivery>> {
  if (!sql || refs.length === 0) return new Map()
  try {
    const rows = (await sql`
      WITH wanted(contract, token_id) AS (
        SELECT * FROM unnest(
          ${refs.map((ref) => ref.contract.toLowerCase())}::text[],
          ${refs.map((ref) => ref.tokenId)}::text[]
        )
      )
      SELECT d.contract, d.token_id, d.status, d.media_kind, d.source_url,
             d.resolved_url, d.thumbnail_url, d.poster_url, d.width, d.height,
             d.mime_type, d.source_bytes, d.derivative_bytes,
             d.derivative_sha256, d.attempt_count, d.last_error,
             d.next_attempt_at
        FROM token_media_delivery d
        JOIN wanted w USING (contract, token_id)
    `) as Array<{
      contract: string
      token_id: string
      status: MediaDeliveryStatus
      media_kind: MediaDelivery["kind"]
      source_url: string
      resolved_url: string | null
      thumbnail_url: string | null
      poster_url: string | null
      width: number | null
      height: number | null
      mime_type: string | null
      source_bytes: number | null
      derivative_bytes: number | null
      derivative_sha256: string | null
      attempt_count: number
      last_error: string | null
      next_attempt_at: Date | null
    }>
    return new Map(
      rows.map((row) => [
        `${row.contract.toLowerCase()}:${row.token_id}`,
        {
          status: row.status,
          kind: row.media_kind,
          originalUrl: row.source_url,
          resolvedUrl: row.resolved_url,
          thumbnailUrl: row.thumbnail_url,
          posterUrl: row.poster_url,
          width: row.width,
          height: row.height,
          mimeType: row.mime_type,
          sourceBytes: row.source_bytes,
          derivativeBytes: row.derivative_bytes,
          sha256: row.derivative_sha256,
          attempts: row.attempt_count,
          lastError: row.last_error,
          nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
        },
      ]),
    )
  } catch (error) {
    // Additive migration rollout: old web instances must keep serving while
    // migration 032 is applied. Any other failure is logged, never disguised
    // as a ready derivative.
    console.warn("[media-delivery] delivery rows unavailable:", error)
    return new Map()
  }
}
