import "server-only"
import { revalidateTag } from "next/cache"
import { sql } from "./db"
import { artistRefsTag } from "./artist-cache"
import {
  ENQUEUE_SQL,
  LATEST_JOB_SQL,
  MARK_CACHE_INVALIDATED_SQL,
  cooldownDecision,
  jobFromRow,
  needsCacheInvalidation,
  type RefreshJob,
  type RefreshJobKind,
  type RefreshJobRow,
} from "./refresh-jobs-core"

/**
 * Durable refresh enqueue + status for the web routes (#297). See
 * refresh-jobs-core.ts for the SQL and decisions, and
 * apps/worker/src/refresh-queue.ts for how the worker runs the jobs.
 *
 * Enqueueing is a plain INSERT, so it works whether or not the worker is
 * reachable; the job waits in Postgres until a worker claims it.
 */

export type EnqueueResult =
  | { kind: "created"; job: RefreshJob }
  | { kind: "refused"; reason: "active" | "cooldown"; retryAfter: number; job: RefreshJob }
  /** refresh_jobs isn't there yet (migration 035 not applied). */
  | { kind: "no-table" }
  | { kind: "unavailable" }

// Postgres undefined_table.
const UNDEFINED_TABLE = "42P01"

function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNDEFINED_TABLE
}

async function latestJob(kind: RefreshJobKind, target: string): Promise<RefreshJob | null> {
  if (!sql) return null
  const rows = (await sql.unsafe(LATEST_JOB_SQL, [kind, target])) as unknown as RefreshJobRow[]
  return rows[0] ? jobFromRow(rows[0]) : null
}

/**
 * Enqueue a refresh unless the target has an active job or finished one
 * within `cooldownSeconds`.
 */
export async function enqueueRefresh(
  kind: RefreshJobKind,
  target: string,
  cooldownSeconds: number,
): Promise<EnqueueResult> {
  if (!sql) return { kind: "unavailable" }
  try {
    const decision = cooldownDecision(await latestJob(kind, target), cooldownSeconds)
    if (!decision.allow) {
      return { kind: "refused", reason: decision.reason, retryAfter: decision.retryAfter, job: decision.job }
    }
    const rows = (await sql.unsafe(ENQUEUE_SQL, [kind, target])) as unknown as RefreshJobRow[]
    if (rows[0]) return { kind: "created", job: jobFromRow(rows[0]) }
    // Lost a race with a concurrent request: its job is the active one.
    const active = await latestJob(kind, target)
    if (active) {
      return { kind: "refused", reason: "active", retryAfter: Math.max(1, Math.ceil(cooldownSeconds)), job: active }
    }
    return { kind: "unavailable" }
  } catch (err) {
    if (isUndefinedTable(err)) return { kind: "no-table" }
    console.error(`[refresh-jobs] enqueue ${kind} ${target}:`, err)
    return { kind: "unavailable" }
  }
}

/**
 * Latest job for a target. For a finished artist job the first reader
 * evicts that artist's cached gallery refs (24h unstable_cache) so the
 * new works show up on the next render, and records it so later polls
 * don't evict again. Per-artist tag only: no global cache flush.
 */
export async function getRefreshStatus(
  kind: RefreshJobKind,
  target: string,
): Promise<RefreshJob | null | "no-table"> {
  if (!sql) return null
  try {
    const job = await latestJob(kind, target)
    if (job && needsCacheInvalidation(job)) {
      const marked = (await sql.unsafe(MARK_CACHE_INVALIDATED_SQL, [job.id])) as unknown[]
      if (marked.length > 0) revalidateTag(artistRefsTag(target))
      return { ...job, cacheInvalidated: true }
    }
    return job
  } catch (err) {
    if (isUndefinedTable(err)) return "no-table"
    throw err
  }
}
