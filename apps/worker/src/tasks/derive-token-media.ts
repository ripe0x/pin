/**
 * Build bounded, disposable delivery derivatives for known artists' external
 * token media. Canonical art stays at its original URI. PND Surface contracts
 * are excluded because their permanent captures belong to RenderAssets and
 * the client-side #271/#272 pipeline.
 *
 * Fetching, classification and the actual thumbnail/poster derivation live
 * in `@pnd/media/node`, reusable outside PND's own worker and database.
 * This file owns only what is PND-specific: the candidate query, the
 * `token_media_delivery` upsert, and the scheduler result.
 */
import { extractArweavePath, extractCid } from "@pin/shared"
import { derivativeKey } from "@pnd/media"
import {
  UnsupportedMediaError,
  deriveMedia,
  s3ConfigFromEnv,
  s3Store,
  type MediaStore,
  type S3StoreConfig,
} from "@pnd/media/node"
import { sql } from "../db.ts"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"
import type { TaskResult } from "../scheduler.ts"

const TASK = "derive-token-media"
const BATCH_SIZE = Math.min(Number(process.env.MEDIA_DERIVE_BATCH_SIZE ?? "12"), 50)
const MAX_ATTEMPTS = Math.min(Number(process.env.MEDIA_DERIVE_MAX_ATTEMPTS ?? "4"), 10)
const MAX_INPUT_BYTES = Math.min(
  Number(process.env.MEDIA_DERIVE_MAX_INPUT_BYTES ?? String(25 * 1024 * 1024)),
  50 * 1024 * 1024,
)
const MAX_PIXELS = Math.min(
  Number(process.env.MEDIA_DERIVE_MAX_PIXELS ?? String(60_000_000)),
  100_000_000,
)
const OUTPUT_WIDTH = Math.min(Number(process.env.MEDIA_DERIVE_WIDTH ?? "800"), 1600)
const DERIVE_OPTIONS = {
  maxInputBytes: MAX_INPUT_BYTES,
  maxPixels: MAX_PIXELS,
  outputWidth: OUTPUT_WIDTH,
}

type Candidate = {
  contract: string
  tokenId: string
  sourceUrl: string
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = ${table}
    ) AS present
  `) as Array<{ present: boolean }>
  return rows[0]?.present === true
}

async function findCandidates(): Promise<Candidate[]> {
  const hasShared = await tableExists(INDEXER_SCHEMA, "fnd_artist_tokens")
  const hasSurface = await tableExists(INDEXER_SCHEMA, "collections")
  const shared = hasShared
    ? `
      UNION SELECT lower(t.contract), t.token_id::text
        FROM ${INDEXER_SCHEMA}.fnd_artist_tokens t
        JOIN known_artists k ON k.address = lower(t.creator)
      UNION SELECT lower(t.contract), t.token_id::text
        FROM ${INDEXER_SCHEMA}.srv2_artist_tokens t
        JOIN known_artists k ON k.address = lower(t.creator)`
    : ""
  const excludeSurface = hasSurface
    ? `AND NOT EXISTS (
         SELECT 1 FROM ${INDEXER_SCHEMA}.collections c
          WHERE lower(c.collection) = d.contract
       )`
    : ""
  return (await sql.unsafe(
    `WITH discovered(contract, token_id) AS (
       SELECT lower(t.contract), t.token_id
         FROM artist_tokens t
         JOIN known_artists k ON k.address = t.artist
       ${shared}
     ), candidates AS (
       SELECT DISTINCT d.contract, d.token_id,
              COALESCE(NULLIF(m.image_url, ''), NULLIF(m.animation_url, '')) AS source_url
         FROM discovered d
         JOIN token_metadata m
           ON m.contract = d.contract AND m.token_id = d.token_id
        WHERE NOT m.burned
          AND COALESCE(NULLIF(m.image_url, ''), NULLIF(m.animation_url, '')) IS NOT NULL
          ${excludeSurface}
     )
     SELECT c.contract, c.token_id AS "tokenId", c.source_url AS "sourceUrl"
       FROM candidates c
       LEFT JOIN token_media_delivery d
         ON d.contract = c.contract AND d.token_id = c.token_id
      WHERE d.contract IS NULL
         OR d.source_url <> c.source_url
         OR (d.status = 'pending' AND d.last_attempt_at < NOW() - INTERVAL '20 minutes')
         OR (d.status = 'failed' AND d.attempt_count < $1
             AND COALESCE(d.next_attempt_at, NOW()) <= NOW())
      ORDER BY COALESCE(d.last_attempt_at, '-infinity'::timestamptz)
      LIMIT $2`,
    [MAX_ATTEMPTS, BATCH_SIZE],
  )) as Candidate[]
}

/** Path used as this row's cache-sharing key: a bare CID/Arweave path, or the URL's path+query+hash. */
function exactSourcePath(sourceUrl: string): string | null {
  const contentPath = extractCid(sourceUrl) ?? extractArweavePath(sourceUrl)
  if (contentPath) return contentPath
  try {
    const url = new URL(sourceUrl)
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

async function markAttempt(candidate: Candidate): Promise<number> {
  const rows = (await sql`
    INSERT INTO token_media_delivery
      (contract, token_id, source_url, source_path, status, attempt_count,
       last_attempt_at, next_attempt_at, last_error, updated_at)
    VALUES
       (${candidate.contract}, ${candidate.tokenId}, ${candidate.sourceUrl},
       ${exactSourcePath(candidate.sourceUrl)}, 'pending', 1, NOW(), NULL, NULL, NOW())
    ON CONFLICT (contract, token_id) DO UPDATE SET
      source_url = EXCLUDED.source_url,
      source_path = EXCLUDED.source_path,
      status = 'pending',
      attempt_count = CASE
        WHEN token_media_delivery.source_url <> EXCLUDED.source_url THEN 1
        ELSE token_media_delivery.attempt_count + 1
      END,
      last_attempt_at = NOW(), next_attempt_at = NULL, last_error = NULL,
      updated_at = NOW()
    RETURNING attempt_count
  `) as Array<{ attempt_count: number }>
  return rows[0]?.attempt_count ?? 1
}

async function reuseExactSource(candidate: Candidate): Promise<boolean> {
  const rows = (await sql`
    SELECT media_kind, resolved_url, source_path, thumbnail_url, poster_url,
           width, height, duration_ms, mime_type, source_bytes,
           derivative_bytes, source_sha256, derivative_sha256, preferred_gateway
      FROM token_media_delivery
     WHERE source_url = ${candidate.sourceUrl} AND status = 'ready'
       AND (thumbnail_url IS NOT NULL OR poster_url IS NOT NULL)
     LIMIT 1
  `) as Array<Record<string, unknown>>
  const source = rows[0]
  if (!source) return false
  await sql`
    UPDATE token_media_delivery SET
      status = 'ready', media_kind = ${source.media_kind as string},
      resolved_url = ${source.resolved_url as string | null},
      source_path = ${source.source_path as string | null},
      thumbnail_url = ${source.thumbnail_url as string | null},
      poster_url = ${source.poster_url as string | null},
      width = ${source.width as number | null}, height = ${source.height as number | null},
      duration_ms = ${source.duration_ms as number | null}, mime_type = ${source.mime_type as string | null},
      source_bytes = ${source.source_bytes as number | null},
      derivative_bytes = ${source.derivative_bytes as number | null},
      source_sha256 = ${source.source_sha256 as string | null},
      derivative_sha256 = ${source.derivative_sha256 as string | null},
      preferred_gateway = ${source.preferred_gateway as string | null},
      last_success_at = NOW(), next_attempt_at = NULL, last_error = NULL, updated_at = NOW()
    WHERE contract = ${candidate.contract} AND token_id = ${candidate.tokenId}
  `
  return true
}

async function processCandidate(
  candidate: Candidate,
  storageConfig: S3StoreConfig,
  store: MediaStore,
): Promise<void> {
  const attempt = await markAttempt(candidate)
  if (await reuseExactSource(candidate)) return
  try {
    const derived = await deriveMedia(candidate.sourceUrl, DERIVE_OPTIONS)
    const key = derivativeKey(storageConfig.prefix, derived.sha256, "webp")
    const { url } = await store.put(key, derived.bytes, derived.mime)
    await sql`
      UPDATE token_media_delivery SET
        status = 'ready', media_kind = ${derived.kind},
        resolved_url = ${derived.resolvedUrl}, preferred_gateway = ${derived.preferredGateway},
        thumbnail_url = ${derived.kind === "image" ? url : null},
        poster_url = ${derived.kind === "video" ? url : null},
        width = ${derived.width}, height = ${derived.height},
        duration_ms = ${derived.durationMs}, mime_type = ${derived.sourceMime},
        source_bytes = ${derived.sourceBytes}, derivative_bytes = ${derived.bytes.length},
        source_sha256 = ${derived.sourceSha256}, derivative_sha256 = ${derived.sha256},
        last_success_at = NOW(), next_attempt_at = NULL, last_error = NULL,
        updated_at = NOW()
      WHERE contract = ${candidate.contract} AND token_id = ${candidate.tokenId}
    `
  } catch (error) {
    const unsupported = error instanceof UnsupportedMediaError
    const delayHours = Math.min(2 ** Math.max(attempt - 1, 0), 24)
    const message = (error as Error).message.slice(0, 1_000)
    await sql`
      UPDATE token_media_delivery SET
        status = ${unsupported ? "unsupported" : "failed"},
        media_kind = ${unsupported ? "animation" : "unknown"},
        last_error = ${message},
        next_attempt_at = ${unsupported || attempt >= MAX_ATTEMPTS ? null : new Date(Date.now() + delayHours * 3_600_000)},
        updated_at = NOW()
      WHERE contract = ${candidate.contract} AND token_id = ${candidate.tokenId}
    `
    if (!unsupported) console.error(`[${TASK}] ${candidate.contract}/${candidate.tokenId}: ${message}`)
  }
}

export async function deriveTokenMedia(): Promise<TaskResult> {
  const storageConfig = s3ConfigFromEnv()
  if (!storageConfig) {
    console.log(`[${TASK}] media object storage not configured, skipping`)
    return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  }
  const store = s3Store(storageConfig)
  const candidates = await findCandidates()
  for (const candidate of candidates) {
    await processCandidate(candidate, storageConfig, store)
  }
  return { scopeCount: candidates.length, rpcCalls: 0, rowsWritten: candidates.length }
}
