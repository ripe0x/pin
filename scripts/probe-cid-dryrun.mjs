#!/usr/bin/env node
/**
 * Dry-run the `probe-cid-availability` worker task against a live
 * database. Reads candidate CIDs the same way the real task does,
 * probes a bounded sample through the real public gateways, and
 * prints results.
 *
 * Does NOT write to `cid_availability` — useful for validating the
 * task before the migration is applied to prod.
 *
 *   # Default: maglev DATABASE_URL from apps/web/.env.local, artist
 *   # 0x8469…d70, sample first 10 CIDs alphabetically.
 *   node scripts/probe-cid-dryrun.mjs
 *
 *   # Override:
 *   DATABASE_URL=postgres://... \
 *   DRY_RUN_ARTIST=0xabc... \
 *   DRY_RUN_LIMIT=20 \
 *   node scripts/probe-cid-dryrun.mjs
 *
 * If `DRY_RUN_ARTIST` is unset, the script falls back to the same
 * known_artists-gated UNION the worker uses. If it's set, the SQL is
 * scoped to that single artist so you can iterate quickly without
 * pulling every artist's CIDs each run.
 */
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

// ── CID extractor (mirrors packages/shared/src/ipfs.ts:extractBareCid) ─
const CIDV0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/
const CIDV1_RE = /^b[A-Za-z2-7]{58,}$/
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

// ── Gateways (mirror the worker task's list and timing) ──────────────
const GATEWAYS = [
  { name: "ipfs.io",   urlFor: (cid) => `https://ipfs.io/ipfs/${cid}` },
  { name: "dweb.link", urlFor: (cid) => `https://${cid}.ipfs.dweb.link/` },
  { name: "w3s.link",  urlFor: (cid) => `https://${cid}.ipfs.w3s.link/` },
]
const TIMEOUT_MS = 3000

async function probeOne(cid) {
  const attempts = GATEWAYS.map(async (g) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const started = Date.now()
    try {
      const res = await fetch(g.urlFor(cid), {
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

const cidSet = new Set()
for (const r of rows) {
  for (const url of [r.raw_uri, r.image_url, r.animation_url]) {
    const cid = extractBareCid(url)
    if (cid) cidSet.add(cid)
  }
}

console.log(`Artist:           ${ARTIST}`)
console.log(`Indexer schema:   ${INDEXER_SCHEMA} (Ponder ready: ${ready})`)
console.log(`Payload-bearing token_metadata rows: ${rows.length}`)
console.log(`Distinct IPFS CIDs referenced:       ${cidSet.size}`)
console.log(`Probing first ${Math.min(LIMIT, cidSet.size)} alphabetically through gateways…\n`)

const sample = [...cidSet].sort().slice(0, LIMIT)

let okCount = 0
let failCount = 0
for (const cid of sample) {
  const results = await probeOne(cid)
  const winner = results.find((r) => r.ok)
  const summary = winner
    ? `OK     via ${winner.name.padEnd(9)} (${winner.status} in ${winner.ms}ms)`
    : `FAIL   ${results.map((r) => `${r.name}:${r.status ?? r.error ?? "?"}`).join(" | ")}`
  console.log(`  ${cid.slice(0, 20)}…  ${summary}`)
  if (winner) okCount++; else failCount++
  // Tiny pacing so we don't hammer any one gateway on a fast run.
  await new Promise((r) => setTimeout(r, 250))
}

console.log("")
console.log(`Result: ${okCount} retrievable, ${failCount} failing (sample of ${sample.length})`)
console.log("No rows written. The real task would upsert these into cid_availability.")

await sql.end()
