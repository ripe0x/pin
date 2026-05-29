/**
 * Probe public IPFS gateways for every CID referenced by
 * `token_metadata` for known-artists' tokens, and cache the result in
 * `cid_availability` keyed by CID.
 *
 * Why this works as a single task with one cache table:
 *   CIDs are content-addressed. The same `Qm...` referenced by N
 *   artists is one row, populated once, queryable for all artists.
 *   That changes the cost profile completely from per-token RPC.
 *
 * Budget notes:
 *   - Gateways used (free, public, no key): ipfs.io, dweb.link, w3s.link.
 *     These are a SEPARATE budget line from the worker's Alchemy /
 *     paid RPC budget — DO NOT route them through `throttleRpc()`.
 *     Standing rule: minimize RPC calls; this task spends zero on
 *     paid providers by construction.
 *   - Per CID: race three gateways in parallel with a 3s HEAD timeout
 *     each via `Promise.any`. First success wins → retrievable=true
 *     and the winning gateway is recorded in `gateways_ok`. All fail →
 *     retrievable=false and every gateway tried lands in
 *     `gateways_failed`.
 *   - HEAD (not GET) because we only need a 200-ish status; we don't
 *     want to ship the content over the wire.
 *   - Per-gateway throttle: a separate `throttleGateway` queue paces
 *     each gateway at ~1 req/s. Independent counters per gateway so
 *     the three race in parallel without serialising through a shared
 *     bottleneck.
 *   - Refresh cadence: 7 days. Pin churn is slow; we don't need to
 *     reprobe more often than that.
 *
 * Spend ceiling: candidates are gated on `known_artists`, the same
 * ceiling that gates `warm-metadata`. Untracked addresses produce
 * zero probes.
 */
import { sql } from "../db.ts"
import { extractBareCid } from "@pin/shared"
import type { TaskResult } from "../scheduler.ts"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

const BATCH_SIZE = Number(process.env.CID_PROBE_BATCH_SIZE ?? "50")
const RETRY_AFTER_DAYS = Number(process.env.CID_PROBE_RETRY_AFTER_DAYS ?? "7")
const GATEWAY_TIMEOUT_MS = Number(process.env.CID_PROBE_TIMEOUT_MS ?? "3000")
const GATEWAY_DELAY_MS = Number(process.env.CID_PROBE_GATEWAY_DELAY_MS ?? "1000")

// Free public IPFS gateways. Tries each one independently per CID;
// first success wins. Throttled per-gateway so a slow round-robin
// doesn't pile up on any single host.
const GATEWAYS = [
  { name: "ipfs.io",   urlFor: (cid: string) => `https://ipfs.io/ipfs/${cid}` },
  { name: "dweb.link", urlFor: (cid: string) => `https://${cid}.ipfs.dweb.link/` },
  { name: "w3s.link",  urlFor: (cid: string) => `https://${cid}.ipfs.w3s.link/` },
] as const

type GatewayName = (typeof GATEWAYS)[number]["name"]

// Per-gateway throttle: each gateway has its own next-slot timestamp.
// We don't share with `throttleRpc` because public gateways are a
// distinct cost line — see the module doc.
const nextSlot: Record<GatewayName, number> = {
  "ipfs.io": 0,
  "dweb.link": 0,
  "w3s.link": 0,
}

async function throttleGateway(name: GatewayName): Promise<void> {
  const now = Date.now()
  const slot = Math.max(now, nextSlot[name])
  nextSlot[name] = slot + GATEWAY_DELAY_MS
  const wait = slot - now
  if (wait > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, wait))
  }
}

type ProbeOutcome = {
  cid: string
  retrievable: boolean
  gatewaysOk: GatewayName[]
  gatewaysFailed: GatewayName[]
  httpStatus: number | null
}

async function probeOne(cid: string): Promise<ProbeOutcome> {
  type GatewayResult =
    | { ok: true; name: GatewayName; status: number }
    | { ok: false; name: GatewayName; status: number | null }

  // Race all three gateways in parallel. `Promise.any` resolves with
  // the first OK; if every probe rejects, it throws AggregateError
  // and we record the failure with whatever last status we observed.
  const attempts: Array<Promise<GatewayResult>> = GATEWAYS.map(
    async (g): Promise<GatewayResult> => {
      await throttleGateway(g.name)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS)
      try {
        const res = await fetch(g.urlFor(cid), {
          method: "HEAD",
          signal: controller.signal,
          redirect: "follow",
        })
        if (res.ok) {
          return { ok: true, name: g.name, status: res.status }
        }
        return { ok: false, name: g.name, status: res.status }
      } catch {
        return { ok: false, name: g.name, status: null }
      } finally {
        clearTimeout(timer)
      }
    },
  )

  // `Promise.any` ignores rejections but we never reject — every probe
  // resolves to `GatewayResult`. We want the first `ok:true` if one
  // exists; otherwise the per-result list.
  const results = await Promise.all(attempts)
  const winner = results.find((r) => r.ok)
  if (winner && winner.ok) {
    return {
      cid,
      retrievable: true,
      gatewaysOk: [winner.name],
      gatewaysFailed: results
        .filter((r): r is Extract<GatewayResult, { ok: false }> => !r.ok)
        .map((r) => r.name),
      httpStatus: winner.status,
    }
  }
  // Every gateway failed. Surface the last observed HTTP status if any
  // (most useful for debugging 429s), or null if everything was a
  // transport-level abort/timeout.
  const lastStatus = results.reduce<number | null>(
    (acc, r) => (r.status !== null ? r.status : acc),
    null,
  )
  return {
    cid,
    retrievable: false,
    gatewaysOk: [],
    gatewaysFailed: results.map((r) => r.name),
    httpStatus: lastStatus,
  }
}

async function findCandidates(): Promise<string[]> {
  // Gate: same known_artists spend ceiling that gates warm-metadata.
  // Without this, this task would probe gateways for every shared
  // 1/1 mint in the database.
  //
  // Source rows: any (contract, token_id) referenced by either the
  // worker's `artist_tokens` or one of Ponder's shared-1/1 tables,
  // whose creator/artist is in known_artists. LEFT JOIN
  // `token_metadata` so we only consider rows with at least one
  // *payload-bearing* URL — the same payload-presence check the
  // dependency-report Display path uses (a row whose raw_uri /
  // image_url / animation_url are all null doesn't carry any CID).
  //
  // De-skip CIDs already probed in the last RETRY_AFTER_DAYS: a stale
  // row is fine — `cid_availability` is the source of truth for
  // freshness.
  const ponderReady = (await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${INDEXER_SCHEMA} AND table_name = 'fnd_artist_tokens'
    ) AS ready
  `) as Array<{ ready: boolean }>

  const cte = ponderReady[0]?.ready
    ? `WITH refs AS (
         SELECT lower(t.contract) AS contract, t.token_id::text AS token_id
           FROM ${INDEXER_SCHEMA}.fnd_artist_tokens t
           JOIN known_artists k ON k.address = lower(t.creator)
         UNION
         SELECT lower(t.contract), t.token_id::text
           FROM ${INDEXER_SCHEMA}.srv2_artist_tokens t
           JOIN known_artists k ON k.address = lower(t.creator)
         UNION
         SELECT lower(t.contract), t.token_id
           FROM artist_tokens t
           JOIN known_artists k ON k.address = t.artist
       )`
    : `WITH refs AS (
         SELECT lower(t.contract) AS contract, t.token_id
           FROM artist_tokens t
           JOIN known_artists k ON k.address = t.artist
       )`

  const rows = (await sql.unsafe(
    `${cte}
     SELECT m.raw_uri, m.image_url, m.animation_url
     FROM refs r
     JOIN token_metadata m
       ON m.contract = r.contract AND m.token_id = r.token_id
     WHERE m.raw_uri        IS NOT NULL
        OR m.image_url      IS NOT NULL
        OR m.animation_url  IS NOT NULL`,
  )) as Array<{
    raw_uri: string | null
    image_url: string | null
    animation_url: string | null
  }>

  const candidates = new Set<string>()
  for (const r of rows) {
    for (const url of [r.raw_uri, r.image_url, r.animation_url]) {
      const cid = extractBareCid(url)
      if (cid) candidates.add(cid)
    }
  }
  if (candidates.size === 0) return []

  // Subtract CIDs already probed inside the freshness window.
  const fresh = (await sql<Array<{ cid: string }>>`
    SELECT cid FROM cid_availability
     WHERE last_probed_at > NOW() - (${RETRY_AFTER_DAYS}::text || ' days')::interval
       AND cid = ANY(${Array.from(candidates)})
  `) as Array<{ cid: string }>
  for (const r of fresh) candidates.delete(r.cid)

  // Stable ordering — sort lexicographically so successive batches
  // don't reshuffle and a backlog drains in deterministic order.
  return Array.from(candidates).sort().slice(0, BATCH_SIZE)
}

async function writeOutcome(o: ProbeOutcome): Promise<void> {
  await sql`
    INSERT INTO cid_availability
      (cid, last_probed_at, retrievable, gateways_ok, gateways_failed, http_status)
    VALUES
      (${o.cid}, NOW(), ${o.retrievable},
       ${o.gatewaysOk}::text[], ${o.gatewaysFailed}::text[], ${o.httpStatus})
    ON CONFLICT (cid) DO UPDATE SET
      last_probed_at  = NOW(),
      retrievable     = EXCLUDED.retrievable,
      gateways_ok     = EXCLUDED.gateways_ok,
      gateways_failed = EXCLUDED.gateways_failed,
      http_status     = EXCLUDED.http_status
  `
}

export async function probeCidAvailability(): Promise<TaskResult> {
  const candidates = await findCandidates()
  if (candidates.length === 0) {
    return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  }

  // Serialise per-CID — the per-gateway throttle gates the actual
  // network rate. Running CIDs sequentially keeps the throttle queue
  // depth at most `GATEWAYS.length` at any moment, so a slow gateway
  // can't fan a backlog across the whole batch.
  let resolved = 0
  let unresolved = 0
  for (const cid of candidates) {
    try {
      const outcome = await probeOne(cid)
      await writeOutcome(outcome)
      if (outcome.retrievable) resolved++
      else unresolved++
    } catch (err) {
      console.error(`[probe-cid-availability] ${cid}:`, err)
      unresolved++
    }
  }

  console.log(
    `[probe-cid-availability] probed ${candidates.length} CIDs ` +
      `(${resolved} retrievable, ${unresolved} unresolved) across ` +
      `${GATEWAYS.length} gateways`,
  )

  return {
    scopeCount: candidates.length,
    // `rpcCalls` is the worker's audit-log column for paid-RPC use.
    // Gateway HEADs are FREE — record 0 so the cost-invariant check
    // can't flag this task as paid-RPC spend.
    rpcCalls: 0,
    rowsWritten: candidates.length,
  }
}
