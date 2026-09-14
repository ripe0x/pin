import "server-only"
import { sql } from "./db"
import type { MediaRecord } from "@pnd/media"

/** Kept as an alias so existing call sites don't have to rename their type import. */
export type MediaDelivery = MediaRecord

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
             d.duration_ms, d.mime_type, d.source_bytes, d.derivative_bytes,
             d.source_sha256, d.derivative_sha256, d.preferred_gateway,
             d.attempt_count, d.last_error, d.last_attempt_at,
             d.last_success_at, d.next_attempt_at
        FROM token_media_delivery d
        JOIN wanted w USING (contract, token_id)
    `) as Array<{
      contract: string
      token_id: string
      status: MediaDelivery["status"]
      media_kind: MediaDelivery["kind"]
      source_url: string
      resolved_url: string | null
      thumbnail_url: string | null
      poster_url: string | null
      width: number | null
      height: number | null
      duration_ms: number | null
      mime_type: string | null
      source_bytes: number | null
      derivative_bytes: number | null
      source_sha256: string | null
      derivative_sha256: string | null
      preferred_gateway: string | null
      attempt_count: number
      last_error: string | null
      last_attempt_at: Date | null
      last_success_at: Date | null
      next_attempt_at: Date | null
    }>
    return new Map(
      rows.map((row) => [
        `${row.contract.toLowerCase()}:${row.token_id}`,
        {
          contract: row.contract.toLowerCase(),
          tokenId: row.token_id,
          sourceUrl: row.source_url,
          resolvedUrl: row.resolved_url,
          kind: row.media_kind,
          status: row.status,
          thumbnailUrl: row.thumbnail_url,
          posterUrl: row.poster_url,
          width: row.width,
          height: row.height,
          durationMs: row.duration_ms,
          mimeType: row.mime_type,
          sourceBytes: row.source_bytes,
          derivativeBytes: row.derivative_bytes,
          sourceSha256: row.source_sha256,
          derivativeSha256: row.derivative_sha256,
          preferredGateway: row.preferred_gateway,
          attemptCount: row.attempt_count,
          lastError: row.last_error,
          lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
          lastSuccessAt: row.last_success_at?.toISOString() ?? null,
          nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
        },
      ]),
    )
  } catch (error) {
    // Additive migration rollout: old web instances must keep serving while
    // migration 027 is applied. Any other failure is logged, never disguised
    // as a ready derivative.
    console.warn("[media-delivery] delivery rows unavailable:", error)
    return new Map()
  }
}
