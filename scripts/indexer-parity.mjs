#!/usr/bin/env node
/**
 * Read-only parity gate for a fresh Ponder schema replay, run BEFORE
 * flipping INDEXER_SCHEMA to it (AGENTS.md "After any fresh schema replay",
 * docs/ponder-schema-cutover.md). It never writes: the session is opened
 * with default_transaction_read_only=on, and it issues SELECTs only.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/indexer-parity.mjs --from ponder_v4 --to ponder_v5
 *     [--spot <collection>]...   per-collection spot check (repeatable)
 *     [--rpc-url <url>]          with --spot: count each sale's onchain Sold
 *                                logs and compare (or env PARITY_RPC_URL).
 *                                Needs archive getLogs: publicnode refuses
 *                                it, Tenderly's public gateway serves it.
 *     [--allow-shrink <table>]   tolerate fewer rows in --to (repeatable)
 *     [--json]                   print the full report as JSON
 *   or the same flags after: DATABASE_URL=... pnpm indexer:parity
 *
 * DATABASE_URL is deliberately not read from .env: name the database you
 * mean on the command line.
 *
 * Checks, all against the live database the two indexers write:
 *   1. Readiness: --to has _ponder_meta is_ready=1; both checkpoints are
 *      printed (block + age) so a lagging target is visible.
 *   2. Tables: every table --from declares exists in --to (new tables are
 *      fine: replays are additive).
 *   3. Columns: every --from column exists in --to, except the known,
 *      reviewed drops in KNOWN_DROPPED_COLUMNS.
 *   4. Row counts, table by table: --to must have at least --from's rows
 *      (it replays the same chain plus whatever it adds). Tables whose
 *      handlers delete rows are WARN, not FAIL, on a shrink.
 *   5. Surface v1 parity: each collection_* table restricted to
 *      protocol_version = 1 collections must not shrink (no v1 handler or
 *      event shape changes between builds of the same contracts).
 *   6. Factory watch sets: for every factory child stream ponder.config.ts
 *      declares, the ponder_sync.factories row this schema's build uses
 *      (address + childAddressLocation + event selector + chain; best
 *      overlap if several builds differ only in fromBlock) must hold every
 *      child in --to's source table (pnd_houses, collections, minters, split
 *      by version). A missing child means its per-clone events were never
 *      indexed: do not cut over, replay again.
 *   7. known_artists: which ponder schema the view currently reads.
 *
 * Exit code: 0 = pass (warnings allowed), 1 = a FAIL check, 2 = usage.
 *
 * Mirrors the stream list of apps/worker/src/tasks/ponder-drift-check.ts;
 * keep the two in sync when a factory binding changes.
 */
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import postgres from "postgres"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/
const CHAIN_ID = 1

// Reviewed column drops between consecutive builds. A drop not listed here
// fails the gate: web on the old schema may still read it.
const KNOWN_DROPPED_COLUMNS = {
  "collections.royalty_locked": "ponder_v5 (#358): v2 has no royalty lock and nothing reads it",
}

// Handlers that delete rows (Catalog unregister), so a later head can
// legitimately hold fewer rows.
const SHRINKABLE_TABLES = new Set(["catalog_contracts", "catalog_tokens", "catalog_ranges"])

// Factory events exactly as apps/indexer/ponder.config.ts binds them.
const AUCTION_HOUSE_CREATED =
  "event AuctionHouseCreated(address indexed owner, address indexed house, address feeRecipient, uint16 protocolFeeBps)"
const SURFACE_CREATED =
  "event SurfaceCreated(address indexed owner, address indexed collection, address primaryMinter, uint8 idMode, string name, string symbol)"
const CLONE_CREATED =
  "event Created(address indexed implementation, address indexed instance, address indexed caller)"

// Mainnet factory addresses (packages/addresses/src/index.ts). Surface v2
// comes from contracts/deployments.mainnet.json, the record ponder.config.ts
// itself reads, so the script follows whatever the indexer subscribes.
const SAH_V1_FACTORY = "0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f"
const SAH_V2_FACTORY = "0x77aB853543286C9Cdd7dd6c01222A7cC4Ac93d63"
const SURFACE_FACTORY = "0xdB81d3F33EF3D84685486916E0d372E247558094"

function usage(message) {
  if (message) console.error(`[indexer-parity] ${message}`)
  console.error(
    "Usage: DATABASE_URL=... node scripts/indexer-parity.mjs --from ponder_vN --to ponder_vM " +
      "[--spot <collection>]... [--rpc-url <url>] [--allow-shrink <table>]... [--json]",
  )
  process.exit(2)
}

function parseArgs(argv) {
  const args = { from: null, to: null, spots: [], rpcUrl: process.env.PARITY_RPC_URL ?? null, allowShrink: new Set(), json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i] ?? usage(`${arg} needs a value`)
    if (arg === "--from") args.from = next()
    else if (arg === "--to") args.to = next()
    else if (arg === "--spot") args.spots.push(next().toLowerCase())
    else if (arg === "--rpc-url") args.rpcUrl = next()
    else if (arg === "--allow-shrink") args.allowShrink.add(next())
    else if (arg === "--json") args.json = true
    else if (arg === "--help" || arg === "-h") usage()
    else usage(`unknown argument: ${arg}`)
  }
  if (!args.from || !args.to) usage("--from and --to are required")
  for (const s of [args.from, args.to]) if (!SCHEMA_RE.test(s)) usage(`not a plain schema name: ${s}`)
  if (args.from === args.to) usage("--from and --to must differ")
  for (const c of args.spots) if (!/^0x[0-9a-f]{40}$/.test(c)) usage(`--spot needs an address: ${c}`)
  return args
}

const q = (schema, table) => `"${schema}"."${table}"`

async function loadViem() {
  // viem is a worker dependency; resolving it from there keeps this root
  // script from adding a second copy to the lockfile.
  const require = createRequire(resolve(repoRoot, "apps/worker/package.json"))
  return import(pathToFileURL(require.resolve("viem")).href)
}

function readSurfaceV2Mainnet() {
  const path = resolve(repoRoot, "contracts/deployments.mainnet.json")
  if (!existsSync(path)) return null
  const record = JSON.parse(readFileSync(path, "utf8"))
  const ok = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v)
  if (!ok(record.surfaceFactoryV2) || !ok(record.saleFactoryV2)) return null
  return { tokenFactory: record.surfaceFactoryV2, saleFactory: record.saleFactoryV2 }
}

const report = { from: null, to: null, checks: [] }
const add = (status, check, detail, data) => {
  report.checks.push({ status, check, detail, ...(data ? { data } : {}) })
}

async function schemaExists(sql, schema) {
  const [row] = await sql`SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}) AS present`
  return row.present
}

async function readMeta(sql, schema) {
  const rows = await sql.unsafe(`SELECT value FROM ${q(schema, "_ponder_meta")} WHERE key = 'app' LIMIT 1`).catch(() => [])
  return rows[0]?.value ?? null
}

async function readCheckpoints(sql, schema) {
  const rows = await sql
    .unsafe(
      `SELECT chain_name, chain_id::text AS chain_id,
              substring(latest_checkpoint, 1, 10)::bigint::text AS block_ts,
              substring(latest_checkpoint, 27, 16)::bigint::text AS block_number
         FROM ${q(schema, "_ponder_checkpoint")} ORDER BY chain_id`,
    )
    .catch(() => [])
  const now = Math.floor(Date.now() / 1000)
  return rows.map((r) => ({
    chain: r.chain_name,
    chainId: Number(r.chain_id),
    block: Number(r.block_number),
    ageSeconds: now - Number(r.block_ts),
  }))
}

async function listTables(sql, schema, meta) {
  if (Array.isArray(meta?.table_names) && meta.table_names.length > 0) return [...meta.table_names].sort()
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_type = 'BASE TABLE' AND table_name NOT LIKE '\\_%'
    ORDER BY table_name`
  return rows.map((r) => r.table_name)
}

async function listColumns(sql, schema) {
  const rows = await sql`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ${schema}`
  const out = new Map()
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Set())
    out.get(r.table_name).add(r.column_name)
  }
  return out
}

async function count(sql, schema, table, where = "") {
  const [row] = await sql.unsafe(`SELECT count(*)::text AS n FROM ${q(schema, table)} ${where}`)
  return Number(row.n)
}

async function checkReadiness(sql, args) {
  for (const schema of [args.from, args.to]) {
    if (!(await schemaExists(sql, schema))) {
      add("FAIL", "schema", `${schema} does not exist`)
      return false
    }
  }
  const metaFrom = await readMeta(sql, args.from)
  const metaTo = await readMeta(sql, args.to)
  report.from = { schema: args.from, buildId: metaFrom?.build_id ?? null, checkpoints: await readCheckpoints(sql, args.from) }
  report.to = { schema: args.to, buildId: metaTo?.build_id ?? null, checkpoints: await readCheckpoints(sql, args.to) }
  const ready = metaTo?.is_ready === 1 || metaTo?.is_ready === true
  add(ready ? "PASS" : "FAIL", "readiness", `${args.to} is_ready=${metaTo?.is_ready ?? "missing"} (still backfilling if 0)`)
  if (metaFrom && metaTo && metaFrom.build_id === metaTo.build_id) {
    add("WARN", "readiness", `both schemas report build ${metaTo.build_id}: is --to really a new replay?`)
  }
  const head = (cps) => cps.find((c) => c.chainId === CHAIN_ID)
  const f = head(report.from.checkpoints)
  const t = head(report.to.checkpoints)
  if (f && t) {
    const lag = f.block - t.block
    add(
      lag > 50 ? "WARN" : "PASS",
      "readiness",
      `mainnet checkpoint ${args.from}=${f.block} (${f.ageSeconds}s old), ${args.to}=${t.block} (${t.ageSeconds}s old)` +
        (lag > 50 ? `: ${args.to} is ${lag} blocks behind, counts below may understate it` : ""),
    )
  }
  return { metaFrom, metaTo }
}

async function checkTablesAndCounts(sql, args, { metaFrom, metaTo }) {
  const fromTables = await listTables(sql, args.from, metaFrom)
  const toTables = new Set(await listTables(sql, args.to, metaTo))
  const shared = fromTables.filter((t) => toTables.has(t))
  const missing = fromTables.filter((t) => !toTables.has(t))
  const added = [...toTables].filter((t) => !fromTables.includes(t)).sort()
  add(missing.length ? "FAIL" : "PASS", "tables", missing.length ? `missing from ${args.to}: ${missing.join(", ")}` : `all ${fromTables.length} ${args.from} tables present`)
  if (added.length) add("INFO", "tables", `new in ${args.to}: ${added.join(", ")}`)

  const fromCols = await listColumns(sql, args.from)
  const toCols = await listColumns(sql, args.to)
  for (const table of shared) {
    const before = fromCols.get(table) ?? new Set()
    const after = toCols.get(table) ?? new Set()
    const dropped = [...before].filter((c) => !after.has(c))
    const newCols = [...after].filter((c) => !before.has(c))
    for (const c of dropped) {
      const key = `${table}.${c}`
      if (KNOWN_DROPPED_COLUMNS[key]) add("INFO", "columns", `${key} dropped: ${KNOWN_DROPPED_COLUMNS[key]}`)
      else add("FAIL", "columns", `${key} exists in ${args.from} but not ${args.to}`)
    }
    if (newCols.length) add("INFO", "columns", `${table}: new columns ${newCols.join(", ")}`)
  }

  const counts = []
  for (const table of shared) {
    const a = await count(sql, args.from, table)
    const b = await count(sql, args.to, table)
    counts.push({ table, [args.from]: a, [args.to]: b, delta: b - a })
    if (b >= a) continue
    const tolerated = SHRINKABLE_TABLES.has(table) || args.allowShrink.has(table)
    add(tolerated ? "WARN" : "FAIL", "rows", `${table}: ${args.to}=${b} < ${args.from}=${a}`)
  }
  add("INFO", "rows", `${counts.length} shared tables counted`, counts)
  if (!report.checks.some((c) => c.check === "rows" && c.status === "FAIL")) {
    add("PASS", "rows", `no untolerated row regression in ${args.to}`)
  }
  return { toTables, toCols, fromCols }
}

async function checkSurfaceV1(sql, args, { toTables, toCols, fromCols }) {
  if (!toTables.has("collections")) return
  const v1 = (schema, cols) =>
    cols.get("collections")?.has("protocol_version")
      ? `(SELECT collection FROM ${q(schema, "collections")} WHERE protocol_version = 1)`
      : `(SELECT collection FROM ${q(schema, "collections")})`
  const tables = [
    ["collections", "collection"],
    ["collection_tokens", "collection"],
    ["collection_mints", "collection"],
    ["collection_sales", "collection"],
    ["collection_referrals", "collection"],
    ["minters", "collection"],
  ].filter(([t]) => toTables.has(t) && fromCols.has(t))
  for (const [table, col] of tables) {
    const a = await count(sql, args.from, table, `WHERE ${col} IN ${v1(args.from, fromCols)}`)
    const b = await count(sql, args.to, table, `WHERE ${col} IN ${v1(args.to, toCols)}`)
    add(b < a ? "FAIL" : b > a ? "WARN" : "PASS", "surface-v1", `${table} (v1 collections): ${args.from}=${a}, ${args.to}=${b}` + (b > a ? " (new v1 activity between the two heads?)" : ""))
  }
  if (toCols.get("collections")?.has("protocol_version")) {
    const rows = await sql.unsafe(
      `SELECT protocol_version, owner_confirmed, (launcher IS NOT NULL) AS launched, count(*)::int AS n
         FROM ${q(args.to, "collections")} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    )
    add("INFO", "surface-v2", `${args.to}.collections by version/owner_confirmed/launched`, rows)
  }
}

async function checkFactoryStreams(sql, args, { toTables, toCols }, viem) {
  const v2 = readSurfaceV2Mainnet()
  if (!v2) add("INFO", "factories", "contracts/deployments.mainnet.json has no Surface v2 factories; v2 streams skipped")
  const sel = (sig) => viem.toEventSelector(sig).toLowerCase()

  const housesVersioned = toCols.get("pnd_houses")?.has("version")
  const collVersioned = toCols.get("collections")?.has("protocol_version")
  const houses = (version) =>
    `SELECT lower(house) AS address FROM ${q(args.to, "pnd_houses")}` + (housesVersioned ? ` WHERE version = ${version}` : version === 1 ? "" : " WHERE false")
  const colls = (version) =>
    `SELECT lower(collection) AS address FROM ${q(args.to, "collections")}` + (collVersioned ? ` WHERE protocol_version = ${version}` : version === 1 ? "" : " WHERE false")
  const mints = (version) =>
    `SELECT lower(m.minter) AS address FROM ${q(args.to, "minters")} m JOIN ${q(args.to, "collections")} c ON c.collection = m.collection` +
    ` WHERE lower(m.minter) <> '0x0000000000000000000000000000000000000000'` +
    (collVersioned ? ` AND c.protocol_version = ${version}` : version === 1 ? "" : " AND false")

  const streams = [
    { label: "PND V1 houses", address: SAH_V1_FACTORY, loc: "topic2", selector: sel(AUCTION_HOUSE_CREATED), table: "pnd_houses", source: houses(1), exact: true },
    { label: "PND V2 houses", address: SAH_V2_FACTORY, loc: "topic2", selector: sel(AUCTION_HOUSE_CREATED), table: "pnd_houses", source: houses(2), exact: true },
    { label: "Surface v1 collections", address: SURFACE_FACTORY, loc: "topic2", selector: sel(SURFACE_CREATED), table: "collections", source: colls(1), exact: true },
    // offset0 also watches address(0) for collections with no primary.
    { label: "Surface v1 minters", address: SURFACE_FACTORY, loc: "offset0", selector: sel(SURFACE_CREATED), table: "minters", source: mints(1), exact: false },
    ...(v2
      ? [
          { label: "Surface v2 collections", address: v2.tokenFactory, loc: "topic2", selector: sel(CLONE_CREATED), table: "collections", source: colls(2), exact: true },
          // Also watches sales bound to collections the token factory never made (ignored by handlers).
          { label: "Surface v2 sales", address: v2.saleFactory, loc: "topic2", selector: sel(CLONE_CREATED), table: "minters", source: mints(2), exact: false },
        ]
      : []),
  ]

  const factories = await sql`SELECT id, factory FROM ponder_sync.factories`.catch(() => null)
  if (!factories) {
    add("FAIL", "factories", "ponder_sync.factories is not readable")
    return
  }

  for (const s of streams) {
    if (!toTables.has(s.table)) continue
    const source = (await sql.unsafe(s.source)).map((r) => r.address)
    const candidates = factories
      .filter((r) => {
        const f = r.factory
        return (
          typeof f.address === "string" &&
          f.address.toLowerCase() === s.address.toLowerCase() &&
          f.childAddressLocation === s.loc &&
          (f.eventSelector ?? "").toLowerCase() === s.selector &&
          (f.chainId == null || Number(f.chainId) === CHAIN_ID)
        )
      })
      .map((r) => ({ id: Number(r.id), fromBlock: r.factory.fromBlock ?? null }))
      .sort((a, b) => a.id - b.id)
    if (candidates.length === 0) {
      add(source.length ? "FAIL" : "INFO", "factories", `${s.label}: no ponder_sync.factories row (${source.length} source rows)`)
      continue
    }
    const scored = []
    for (const c of candidates) {
      const watched = new Set(
        (await sql`SELECT lower(address) AS address FROM ponder_sync.factory_addresses WHERE chain_id = ${CHAIN_ID} AND factory_id = ${c.id}`).map((r) => r.address),
      )
      const overlap = source.filter((a) => watched.has(a)).length
      const sourceSet = new Set(source)
      scored.push({
        ...c,
        watched: watched.size,
        overlap,
        missing: source.filter((a) => !watched.has(a)),
        extra: [...watched].filter((a) => !sourceSet.has(a)),
      })
    }
    scored.sort((a, b) => b.overlap - a.overlap || a.id - b.id)
    const best = scored[0]
    const tie = scored.length > 1 && scored[1].overlap === best.overlap
    const summary = scored.map((c) => ({ factoryId: c.id, fromBlock: c.fromBlock, watched: c.watched, overlap: c.overlap, missing: c.missing.length, extra: c.extra.length }))
    if (tie && source.length > 0) {
      add("FAIL", "factories", `${s.label}: ambiguous factories rows ${scored.filter((c) => c.overlap === best.overlap).map((c) => c.id).join(",")}`, summary)
      continue
    }
    if (best.missing.length > 0) {
      add("FAIL", "factories", `${s.label}: ${best.missing.length}/${source.length} ${args.to}.${s.table} children missing from factory_id=${best.id} (e.g. ${best.missing.slice(0, 5).join(",")})`, summary)
    } else {
      add("PASS", "factories", `${s.label}: factory_id=${best.id} watches all ${source.length} children (${best.watched} watched)`, summary)
    }
    if (best.extra.length > 0) {
      add(s.exact ? "WARN" : "INFO", "factories", `${s.label}: ${best.extra.length} watched children have no ${args.to}.${s.table} row (e.g. ${best.extra.slice(0, 5).join(",")})`)
    }
  }
}

async function countSoldLogs(viem, rpcUrl, sale, fromBlock) {
  const client = viem.createPublicClient({ transport: viem.http(rpcUrl, { timeout: 20_000 }) })
  const head = await client.getBlockNumber()
  const event = viem.parseAbiItem(
    "event Sold(address indexed payer, address indexed to, address indexed referrer, uint256 quantity, uint256 paid, uint256 firstTokenId)",
  )
  let total = 0
  const STEP = 10_000n
  for (let start = BigInt(fromBlock); start <= head; start += STEP) {
    const end = start + STEP - 1n > head ? head : start + STEP - 1n
    const logs = await client.getLogs({ address: sale, event, fromBlock: start, toBlock: end })
    total += logs.length
  }
  return total
}

async function checkSpots(sql, args, { toTables, toCols }, viem) {
  if (args.spots.length === 0) return
  for (const t of ["collections", "minters", "collection_tokens", "collection_sales"]) {
    if (!toTables.has(t)) {
      add("FAIL", "spot", `${args.to}.${t} does not exist`)
      return
    }
  }
  for (const collection of args.spots) {
    const cols = toCols.get("collections") ?? new Set()
    const pick = ["collection", "owner", "protocol_version", "owner_confirmed", "launcher", "name", "primary_minter", "created_at_block"].filter((c) => cols.has(c))
    const [row] = await sql.unsafe(`SELECT ${pick.join(", ")} FROM ${q(args.to, "collections")} WHERE collection = $1`, [collection])
    if (!row) {
      add("FAIL", "spot", `${collection}: no ${args.to}.collections row`)
      continue
    }
    add("PASS", "spot", `${collection}: collections row present`, row)
    const sales = await sql.unsafe(`SELECT minter FROM ${q(args.to, "minters")} WHERE collection = $1`, [collection])
    add(sales.length ? "PASS" : "FAIL", "spot", `${collection}: ${sales.length} minters row(s) ${sales.map((s) => s.minter).join(",")}`)
    const tokens = await count(sql, args.to, "collection_tokens", `WHERE collection = '${collection}'`)
    add("INFO", "spot", `${collection}: ${tokens} collection_tokens rows`)
    for (const { minter } of sales) {
      const indexed = await count(sql, args.to, "collection_sales", `WHERE minter = '${minter.toLowerCase()}'`)
      if (!args.rpcUrl) {
        add("INFO", "spot", `${minter}: ${indexed} collection_sales rows (pass --rpc-url to compare with onchain Sold logs)`)
        continue
      }
      const onchain = await countSoldLogs(viem, args.rpcUrl, minter, row.created_at_block)
      add(onchain === indexed ? "PASS" : "FAIL", "spot", `${minter}: collection_sales=${indexed}, onchain Sold=${onchain}`)
    }
  }
}

async function checkKnownArtists(sql, args) {
  const [row] = await sql`
    SELECT pg_get_viewdef('public.known_artists'::regclass, true) AS def
    WHERE to_regclass('public.known_artists') IS NOT NULL`
  if (!row) {
    add("INFO", "known_artists", "public.known_artists does not exist")
    return
  }
  const schemas = [...new Set(row.def.match(/ponder_v\d+/g) ?? [])]
  add(
    schemas.includes(args.to) ? "PASS" : "INFO",
    "known_artists",
    `view reads ${schemas.join(", ") || "no ponder schema"}` +
      (schemas.includes(args.to) ? "" : `; rebuild it for ${args.to} at the flip (docs/ponder-schema-cutover.md)`),
  )
}

const args = parseArgs(process.argv.slice(2))
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) usage("DATABASE_URL is required")

const sql = postgres(databaseUrl, {
  ssl: "prefer",
  prepare: false,
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
  connection: { default_transaction_read_only: "on", application_name: "indexer-parity" },
})

let exitCode = 0
try {
  const viem = await loadViem()
  const metas = await checkReadiness(sql, args)
  if (metas) {
    const shape = await checkTablesAndCounts(sql, args, metas)
    await checkSurfaceV1(sql, args, shape)
    await checkFactoryStreams(sql, args, shape, viem)
    await checkSpots(sql, args, shape, viem)
    await checkKnownArtists(sql, args)
  }
} catch (err) {
  add("FAIL", "error", err instanceof Error ? err.message : String(err))
} finally {
  await sql.end({ timeout: 1 })
}

if (report.checks.some((c) => c.status === "FAIL")) exitCode = 1
if (args.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const side of [report.from, report.to]) {
    if (side) console.log(`${side.schema}: build ${side.buildId ?? "?"}`)
  }
  for (const c of report.checks) {
    console.log(`${c.status.padEnd(4)} ${c.check}: ${c.detail}`)
    if (c.data && c.check !== "rows") console.log(`       ${JSON.stringify(c.data)}`)
  }
  const rows = report.checks.find((c) => c.check === "rows" && c.data)
  if (rows) console.table(rows.data)
  console.log(exitCode === 0 ? "[indexer-parity] PASS" : "[indexer-parity] FAIL")
}
process.exit(exitCode)
