#!/usr/bin/env node
/**
 * Dry-run (or write-through) the `probe-cid-availability` worker task
 * against a live database. Reads candidate CIDs the same way the real
 * task does, probes a bounded sample through the real public
 * gateways, and prints results.
 *
 *   # Read-only default — does NOT write to cid_availability:
 *   node scripts/probe-cid-dryrun.mjs
 *
 *   # Write-through: upserts each outcome into cid_availability AND
 *   # busts the dependency-report L2 cache for the artist, so the
 *   # next /dependency/<addr> page load picks up the new counts.
 *   node scripts/probe-cid-dryrun.mjs --write
 *
 *   # Bigger sample / different artist:
 *   DRY_RUN_LIMIT=50 DRY_RUN_ARTIST=0xabc... \
 *     node scripts/probe-cid-dryrun.mjs --write
 *
 * DATABASE_URL is read from apps/web/.env.local by default; override
 * by exporting it (or `--env-file=`).
 */
const WRITE = process.argv.includes("--write")
import postgres from "postgres"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")

function loadDotEnv(path) {
  try {
    const raw = readFileSync(path, "utf8")
    const out = {}
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
    }
    return out
  } catch {
    return {}
  }
}

// Resolve DATABASE_URL: explicit env wins, then apps/web/.env.local.
const envFile = loadDotEnv(join(ROOT, "apps/web/.env.local"))
const DATABASE_URL = process.env.DATABASE_URL ?? envFile.DATABASE_URL
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (in env or apps/web/.env.local).")
  process.exit(1)
}
const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? envFile.INDEXER_SCHEMA ?? "ponder_v1")
  .replace(/[^a-zA-Z0-9_]/g, "")

const ARTIST = (process.env.DRY_RUN_ARTIST ?? "0x8469b7b08d30c63fea3a248a198de9d634b63d70").toLowerCase()
const LIMIT = Number(process.env.DRY_RUN_LIMIT ?? "10")

// ── extractors (mirror packages/shared/src/ipfs.ts) ───────────────────
const CIDV0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/
const CIDV1_RE = /^b[A-Za-z2-7]{58,}$/
const ARWEAVE_ID_RE = /^[A-Za-z0-9_-]{43}$/

function looksLikeCid(token) {
  return CIDV0_RE.test(token) || CIDV1_RE.test(token)
}
function extractBareCid(uri) {
  if (!uri) return null
  const trimmed = String(uri).trim()
  if (!trimmed) return null
  const ipfsScheme = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)/i.exec(trimmed)
  if (ipfsScheme) return looksLikeCid(ipfsScheme[1]) ? ipfsScheme[1] : null
  if (!/^https?:\/\//i.test(trimmed)) return null
  let parsed
  try { parsed = new URL(trimmed) } catch { return null }
  const subdomain = /^([^.]+)\.ipfs\./i.exec(parsed.hostname)
  if (subdomain && looksLikeCid(subdomain[1])) return subdomain[1]
  const pathMatch = /^\/ipfs\/([^/?#]+)/i.exec(parsed.pathname)
  if (pathMatch && looksLikeCid(pathMatch[1])) return pathMatch[1]
  return null
}
function extractArweaveId(uri) {
  if (!uri) return null
  const trimmed = String(uri).trim()
  if (!trimmed) return null
  const ar = /^ar:\/\/([^/?#]+)/i.exec(trimmed)
  if (ar) return ARWEAVE_ID_RE.test(ar[1]) ? ar[1] : null
  if (!/^https?:\/\//i.test(trimmed)) return null
  let parsed
  try { parsed = new URL(trimmed) } catch { return null }
  const host = parsed.hostname.toLowerCase()
  if (host !== "arweave.net" && !host.endsWith(".arweave.net")) return null
  const m = /^\/([^/?#]+)/.exec(parsed.pathname)
  if (!m) return null
  return ARWEAVE_ID_RE.test(m[1]) ? m[1] : null
}

// ── Gateways per kind (mirror the worker task) ────────────────────────
const IPFS_GATEWAYS = [
  { name: "ipfs.io",   urlFor: (cid) => `https://ipfs.io/ipfs/${cid}` },
  { name: "dweb.link", urlFor: (cid) => `https://${cid}.ipfs.dweb.link/` },
  { name: "w3s.link",  urlFor: (cid) => `https://${cid}.ipfs.w3s.link/` },
]
const ARWEAVE_GATEWAYS = [
  { name: "arweave.net", urlFor: (id) => `https://arweave.net/${id}` },
]
// Same per-kind timeout split as the worker task: Arweave's canonical
// gateway is materially slower than the IPFS pool.
const IPFS_TIMEOUT_MS = 3000
const ARWEAVE_TIMEOUT_MS = 8000

async function probeOne(kind, id) {
  const gws = kind === "ipfs" ? IPFS_GATEWAYS : ARWEAVE_GATEWAYS
  const timeout = kind === "ipfs" ? IPFS_TIMEOUT_MS : ARWEAVE_TIMEOUT_MS
  const attempts = gws.map(async (g) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const started = Date.now()
    try {
      const res = await fetch(g.urlFor(id), {
        method: "HEAD",
        signal: controller.signal,
        redirect: "follow",
      })
      return { name: g.name, ok: res.ok, status: res.status, ms: Date.now() - started }
    } catch (err) {
      return {
        name: g.name,
        ok: false,
        status: null,
        ms: Date.now() - started,
        error: err?.name === "AbortError" ? "timeout" : (err?.message ?? "error"),
      }
    } finally {
      clearTimeout(timer)
    }
  })
  return Promise.all(attempts)
}

const sql = postgres(DATABASE_URL, {
  ssl: "prefer",
  prepare: false,
  max: 2,
  idle_timeout: 5,
  connect_timeout: 10,
})

const ponderReady = await sql`
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = ${INDEXER_SCHEMA} AND table_name = 'fnd_artist_tokens'
  ) AS ready
`
const ready = ponderReady[0]?.ready === true

const cte = ready
  ? `WITH refs AS (
       SELECT lower(t.contract) AS contract, t.token_id::text AS token_id
         FROM ${INDEXER_SCHEMA}.fnd_artist_tokens t
         WHERE lower(t.creator) = $1
       UNION
       SELECT lower(t.contract), t.token_id::text
         FROM ${INDEXER_SCHEMA}.srv2_artist_tokens t
         WHERE lower(t.creator) = $1
       UNION
       SELECT lower(t.contract), t.token_id
         FROM artist_tokens t
         WHERE t.artist = $1
     )`
  : `WITH refs AS (
       SELECT lower(t.contract) AS contract, t.token_id
         FROM artist_tokens t
         WHERE t.artist = $1
     )`

const rows = await sql.unsafe(
  `${cte}
   SELECT m.raw_uri, m.image_url, m.animation_url
   FROM refs r
   JOIN token_metadata m
     ON m.contract = r.contract AND m.token_id = r.token_id
   WHERE m.raw_uri       IS NOT NULL
      OR m.image_url     IS NOT NULL
      OR m.animation_url IS NOT NULL`,
  [ARTIST],
)

const ipfsSet = new Set()
const arweaveSet = new Set()
for (const r of rows) {
  for (const url of [r.raw_uri, r.image_url, r.animation_url]) {
    const cid = extractBareCid(url)
    if (cid) ipfsSet.add(cid)
    const ar = extractArweaveId(url)
    if (ar) arweaveSet.add(ar)
  }
}

console.log(`Artist:           ${ARTIST}`)
console.log(`Indexer schema:   ${INDEXER_SCHEMA} (Ponder ready: ${ready})`)
console.log(`Payload-bearing token_metadata rows: ${rows.length}`)
console.log(`Distinct IPFS CIDs:    ${ipfsSet.size}`)
console.log(`Distinct Arweave ids:  ${arweaveSet.size}`)
console.log(`Probing first ${LIMIT} of each kind alphabetically through their gateways…\n`)

const ipfsSample    = [...ipfsSet].sort().slice(0, LIMIT)
const arweaveSample = [...arweaveSet].sort().slice(0, LIMIT)
const sample = [
  ...ipfsSample.map((id) => ({ kind: "ipfs", id })),
  ...arweaveSample.map((id) => ({ kind: "arweave", id })),
]

let okCount = 0
let failCount = 0
let lastKind = ""
for (const { kind, id } of sample) {
  if (kind !== lastKind) {
    console.log(`\n── ${kind.toUpperCase()} ──`)
    lastKind = kind
  }
  const results = await probeOne(kind, id)
  const winner = results.find((r) => r.ok)
  const summary = winner
    ? `OK     via ${winner.name.padEnd(11)} (${winner.status} in ${winner.ms}ms)`
    : `FAIL   ${results.map((r) => `${r.name}:${r.status ?? r.error ?? "?"}`).join(" | ")}`
  console.log(`  ${id.slice(0, 20)}…  ${summary}`)
  if (winner) okCount++; else failCount++

  if (WRITE) {
    const gatewaysOk = winner ? [winner.name] : []
    const gatewaysFailed = results.filter((r) => !r.ok).map((r) => r.name)
    const lastStatus = results.reduce(
      (acc, r) => (r.status !== null && r.status !== undefined ? r.status : acc),
      null,
    )
    await sql`
      INSERT INTO cid_availability
        (cid, last_probed_at, retrievable, gateways_ok, gateways_failed, http_status)
      VALUES
        (${id}, NOW(), ${!!winner},
         ${gatewaysOk}::text[], ${gatewaysFailed}::text[], ${lastStatus})
      ON CONFLICT (cid) DO UPDATE SET
        last_probed_at  = NOW(),
        retrievable     = EXCLUDED.retrievable,
        gateways_ok     = EXCLUDED.gateways_ok,
        gateways_failed = EXCLUDED.gateways_failed,
        http_status     = EXCLUDED.http_status
    `
  }

  await new Promise((r) => setTimeout(r, 250))
}

console.log("")
console.log(`Result: ${okCount} retrievable, ${failCount} failing (sample of ${sample.length})`)
if (WRITE) {
  // Bust the dependency-report L2 cache for this artist so the next
  // page load picks up the new cid_availability rows instead of the
  // pre-write snapshot. The L1 (unstable_cache) also evicts on the
  // dev server's revalidate window, but L2 lives in Postgres and
  // would otherwise serve stale data for up to 5 minutes.
  const key = `artist-dependency:${ARTIST.toLowerCase()}`
  await sql`DELETE FROM cache_entries WHERE key = ${key}`
  console.log(`Wrote ${sample.length} rows to cid_availability.`)
  console.log(`Cleared cache_entries row for ${key}.`)
  console.log(`Refresh /dependency/${ARTIST} to see the IPFS bar update.`)
} else {
  console.log("No rows written. Pass --write to also upsert and bust the report cache.")
}

await sql.end()
