import "server-only"
import { randomUUID } from "node:crypto"
import { revalidateTag } from "next/cache"
import { sql } from "./db"

export type RefreshSourceState = {
  status: "pending" | "partial" | "complete" | "failed"
  added?: number
  total?: number
  indexedThroughBlock?: string | null
  error?: string | null
}

export type RefreshJobResult = {
  sources?: Record<string, RefreshSourceState>
  addedTotal?: number
}

export type RefreshJobStatus =
  | "queued"
  | "running"
  | "partial"
  | "complete"
  | "failed"

export type RefreshJob = {
  id: string
  artist: string
  status: RefreshJobStatus
  requestedAt: string
  startedAt: string | null
  finishedAt: string | null
  result: RefreshJobResult
  error: string | null
}

type RefreshJobRow = {
  id: string
  artist: string
  status: RefreshJobStatus
  requested_at: Date | string
  started_at: Date | string | null
  finished_at: Date | string | null
  result: RefreshJobResult | null
  error: string | null
  cache_invalidated_at?: Date | string | null
}

const COOLDOWN_SECONDS = 5 * 60

function iso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toJob(row: RefreshJobRow): RefreshJob {
  return {
    id: row.id,
    artist: row.artist,
    status: row.status,
    requestedAt: iso(row.requested_at)!,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    result: row.result ?? {},
    error: row.error,
  }
}

export type CreateRefreshJobResult =
  | { kind: "created"; job: RefreshJob }
  | { kind: "active"; job: RefreshJob }
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "unavailable" }

/** Insert a restart-safe queue row, or return the artist's existing active job. */
export async function createRefreshJob(
  artist: string,
): Promise<CreateRefreshJobResult> {
  if (!sql) return { kind: "unavailable" }
  const lower = artist.toLowerCase()

  const active = (await sql`
    SELECT id, artist, status, requested_at, started_at, finished_at, result, error
    FROM refresh_jobs
    WHERE artist = ${lower} AND status IN ('queued', 'running')
    ORDER BY requested_at DESC
    LIMIT 1
  `) as RefreshJobRow[]
  if (active[0]) return { kind: "active", job: toJob(active[0]) }

  const recent = (await sql`
    SELECT EXTRACT(EPOCH FROM (NOW() - requested_at))::int AS age_seconds
    FROM refresh_jobs
    WHERE artist = ${lower}
    ORDER BY requested_at DESC
    LIMIT 1
  `) as Array<{ age_seconds: number }>
  const age = recent[0]?.age_seconds
  if (age != null && age < COOLDOWN_SECONDS) {
    return {
      kind: "rate-limited",
      retryAfter: Math.max(1, COOLDOWN_SECONDS - age),
    }
  }

  const id = randomUUID()
  try {
    const rows = (await sql`
      INSERT INTO refresh_jobs (id, artist)
      VALUES (${id}, ${lower})
      RETURNING id, artist, status, requested_at, started_at, finished_at, result, error
    `) as RefreshJobRow[]
    return { kind: "created", job: toJob(rows[0]) }
  } catch (error) {
    // A concurrent request may have won the partial unique index after our
    // first active lookup. Read that row instead of surfacing a false 500.
    const rows = (await sql`
      SELECT id, artist, status, requested_at, started_at, finished_at, result, error
      FROM refresh_jobs
      WHERE artist = ${lower} AND status IN ('queued', 'running')
      ORDER BY requested_at DESC
      LIMIT 1
    `) as RefreshJobRow[]
    if (rows[0]) return { kind: "active", job: toJob(rows[0]) }
    throw error
  }
}

export async function getRefreshJob(
  artist: string,
  jobId: string,
): Promise<RefreshJob | null> {
  if (!sql) return null
  const rows = (await sql`
    SELECT id, artist, status, requested_at, started_at, finished_at, result,
           error, cache_invalidated_at
    FROM refresh_jobs
    WHERE id = ${jobId} AND artist = ${artist.toLowerCase()}
    LIMIT 1
  `) as RefreshJobRow[]
  const row = rows[0]
  if (!row) return null

  // The worker and Netlify do not share an in-process cache. The first status
  // poll that observes successful completion evicts this artist's two gallery
  // layers and records that it did so, making repeated polls cheap.
  if (
    (row.status === "complete" || row.status === "partial") &&
    !row.cache_invalidated_at
  ) {
    revalidateArtistCaches(artist)
    await sql`
      UPDATE refresh_jobs
      SET cache_invalidated_at = NOW(), updated_at = NOW()
      WHERE id = ${jobId} AND cache_invalidated_at IS NULL
    `
  }
  return toJob(row)
}

export async function failRefreshJob(jobId: string, error: string): Promise<void> {
  if (!sql) return
  await sql`
    UPDATE refresh_jobs
    SET status = 'failed', error = ${error}, finished_at = NOW(),
        updated_at = NOW(), lease_expires_at = NULL
    WHERE id = ${jobId} AND status IN ('queued', 'running')
  `
}

export function artistRefsTag(artist: string): string {
  return `artist-refs:${artist.toLowerCase()}`
}

export function artistEnrichedTag(artist: string): string {
  return `artist-enriched:${artist.toLowerCase()}`
}

export function revalidateArtistCaches(artist: string): void {
  revalidateTag(artistRefsTag(artist))
  revalidateTag(artistEnrichedTag(artist))
}
