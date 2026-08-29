#!/usr/bin/env node
/**
 * Atomically repoint the stable `indexer_live` schema at a completed Ponder
 * schema. This is the only supported production cutover path.
 *
 * Initial alias:
 *   DATABASE_URL=... node scripts/switch-indexer-schema.mjs \
 *     --target ponder_vN --from ponder_vN
 *
 * Forward cutover:
 *   DATABASE_URL=... node scripts/switch-indexer-schema.mjs \
 *     --target ponder_v3 [--verify-auctions]
 *
 * Rollback, after restarting the indexer against the previous schema:
 *   DATABASE_URL=... node scripts/switch-indexer-schema.mjs \
 *     --target ponder_vN --rollback [--verify-auctions]
 */
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import postgres from "postgres"

const ALIAS_SCHEMA = "indexer_live"
const SWITCH_LOCK = "pnd:indexer-schema-switch"
const VERSIONED_SCHEMA_RE = /^ponder_v[0-9]+$/
const IDENT_RE = /^[a-z_][a-z0-9_]*$/

// This list mirrors every export in apps/indexer/ponder.schema.ts. Checking
// only `_ponder_meta.table_names` would let an indexer built from incomplete
// source declare its own incomplete schema valid.
const REQUIRED_TABLES = [
  "pnd_auctions",
  "pnd_houses",
  "pnd_bids",
  "fnd_auctions",
  "fnd_bids",
  "fnd_buy_nows",
  "fnd_sales",
  "fnd_collections",
  "fnd_artist_tokens",
  "catalog_contracts",
  "catalog_tokens",
  "catalog_ranges",
  "mint_creators",
  "tl_creators",
  "srv2_artist_tokens",
  "token_ownership",
  "muri_contracts",
  "muri_tokens",
  "collections",
  "minters",
  "collection_supply_configs",
  "minter_sale_configs",
  "collection_tokens",
  "collection_mints",
  "collection_sales",
  "collection_referrals",
  "homage_tokens",
  "homage_activity",
  "homage_config",
]

function usage(message) {
  if (message) console.error(message)
  console.error(
    "Usage: node scripts/switch-indexer-schema.mjs --target ponder_vN " +
      "[--from ponder_vN] [--rollback] [--verify-auctions]",
  )
  process.exit(2)
}

function parseArgs(argv) {
  const args = {
    target: null,
    from: null,
    rollback: false,
    verifyAuctions: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--target") args.target = argv[++i] ?? null
    else if (arg === "--from") args.from = argv[++i] ?? null
    else if (arg === "--rollback") args.rollback = true
    else if (arg === "--verify-auctions") args.verifyAuctions = true
    else usage(`Unknown argument: ${arg}`)
  }
  if (!args.target || !VERSIONED_SCHEMA_RE.test(args.target)) {
    usage("--target must be a versioned Ponder schema such as ponder_v3")
  }
  if (args.from && !VERSIONED_SCHEMA_RE.test(args.from)) {
    usage("--from must be a versioned Ponder schema such as ponder_v2")
  }
  if (args.rollback && args.from) usage("--rollback and --from cannot be combined")
  return args
}

function quoteIdent(value) {
  if (!IDENT_RE.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`)
  return `"${value}"`
}

function qualified(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`
}

function asNumber(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Unsafe table count: ${value}`)
  }
  return number
}

async function readMeta(sql, schema, { requireLocked = true } = {}) {
  const exists = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = '_ponder_meta'
    ) AS present
  `
  if (!exists[0]?.present) throw new Error(`${schema}._ponder_meta is missing`)

  const rows = await sql.unsafe(
    `SELECT value FROM ${qualified(schema, "_ponder_meta")} WHERE key = 'app' LIMIT 1`,
  )
  const meta = rows[0]?.value
  const ready = meta?.is_ready === 1 || meta?.is_ready === true
  const locked = meta?.is_locked === 1 || meta?.is_locked === true
  if (!meta || !ready || (requireLocked && !locked)) {
    throw new Error(
      `${schema} is not cutover-ready ` +
        `(is_ready=${meta?.is_ready ?? "missing"}, ` +
        `is_locked=${meta?.is_locked ?? "missing"}, require_locked=${requireLocked})`,
    )
  }
  if (!meta.build_id || !Array.isArray(meta.table_names)) {
    throw new Error(`${schema} has malformed Ponder app metadata`)
  }
  return meta
}

async function validateTables(sql, schema, meta, requiredTables = REQUIRED_TABLES) {
  const relations = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema}
  `
  const actual = new Set(relations.map((row) => row.table_name))
  const declared = new Set(meta.table_names)
  const missingDeclared = meta.table_names.filter((table) => !actual.has(table))
  if (missingDeclared.length > 0) {
    throw new Error(
      `${schema} metadata names missing physical tables: ${missingDeclared.join(", ")}`,
    )
  }
  const missing = requiredTables.filter(
    (table) => !actual.has(table) || !declared.has(table),
  )
  if (missing.length > 0) {
    throw new Error(`${schema} is missing required Ponder tables: ${missing.join(", ")}`)
  }
}

async function countTables(sql, schema, tables) {
  const counts = {}
  for (const table of tables) {
    const rows = await sql.unsafe(
      `SELECT count(*)::text AS n FROM ${qualified(schema, table)}`,
    )
    counts[table] = asNumber(rows[0]?.n ?? "0")
  }
  return counts
}

function assertNoRegression(target, baseline, label) {
  const regressions = []
  for (const table of Object.keys(baseline)) {
    const before = baseline[table]
    const after = target[table]
    if (after === undefined) {
      regressions.push(`${table}: missing (was ${before})`)
    } else if (after < before) {
      regressions.push(`${table}: ${after} < ${before}`)
    }
  }
  if (regressions.length > 0) {
    throw new Error(`Row-count regression against ${label}: ${regressions.join("; ")}`)
  }
}

async function resolveFactory(sql, schema) {
  const houses = await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${qualified(schema, "pnd_houses")}`,
  )
  const houseCount = houses[0]?.n ?? 0
  if (houseCount === 0) {
    return { factoryId: null, houseCount, missingSync: 0, missingHouses: 0 }
  }

  const matches = await sql.unsafe(
    `SELECT fa.factory_id::int AS factory_id, count(*)::int AS matches
       FROM ponder_sync.factory_addresses fa
       JOIN ${qualified(schema, "pnd_houses")} p
         ON lower(p.house) = lower(fa.address)
      WHERE fa.chain_id = 1
      GROUP BY fa.factory_id
      ORDER BY matches DESC, fa.factory_id
      LIMIT 1`,
  )
  const factoryId = matches[0]?.factory_id
  if (factoryId === undefined) {
    throw new Error(`${schema}: no factory_addresses overlap for ${houseCount} houses`)
  }

  const missingSyncRows = await sql.unsafe(
    `SELECT count(*)::int AS n
       FROM ${qualified(schema, "pnd_houses")} p
      WHERE NOT EXISTS (
        SELECT 1 FROM ponder_sync.factory_addresses fa
         WHERE fa.chain_id = 1 AND fa.factory_id = $1
           AND lower(fa.address) = lower(p.house)
      )`,
    [factoryId],
  )
  const missingSync = missingSyncRows[0]?.n ?? 0

  const missingHousesRows = await sql.unsafe(
    `SELECT count(*)::int AS n
       FROM ponder_sync.factory_addresses fa
      WHERE fa.chain_id = 1 AND fa.factory_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM ${qualified(schema, "pnd_houses")} p
           WHERE lower(p.house) = lower(fa.address)
        )`,
    [factoryId],
  )
  const missingHouses = missingHousesRows[0]?.n ?? 0
  if (missingSync > 0 || missingHouses > 0) {
    throw new Error(
      `${schema}: PND factory drift (factory_id=${factoryId}, ` +
        `houses_missing_from_sync=${missingSync}/${houseCount}, ` +
        `sync_children_missing_from_houses=${missingHouses})`,
    )
  }
  return { factoryId, houseCount, missingSync, missingHouses }
}

async function loadViem() {
  // viem is an explicit worker dependency. Resolving from that package keeps
  // the root control-plane script from adding a second version to the lockfile.
  const require = createRequire(new URL("../apps/worker/package.json", import.meta.url))
  const viem = await import(pathToFileURL(require.resolve("viem")).href)
  const chains = await import(pathToFileURL(require.resolve("viem/chains")).href)
  return { ...viem, mainnet: chains.mainnet }
}

async function verifyAuctionParity(sql, schema) {
  const rpcUrl =
    process.env.CUTOVER_RPC_URL ??
    process.env.PONDER_RPC_URL_1 ??
    "https://gateway.tenderly.co/public/mainnet"
  const { createPublicClient, http, mainnet } = await loadViem()
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 20_000 }),
  })
  const houses = await sql.unsafe(
    `SELECT lower(h.house) AS house, count(a.id)::int AS indexed
       FROM ${qualified(schema, "pnd_houses")} h
       LEFT JOIN ${qualified(schema, "pnd_auctions")} a
         ON lower(a.house) = lower(h.house)
      GROUP BY h.house
      ORDER BY h.house`,
  )
  if (houses.length === 0) return

  const abi = [
    {
      type: "function",
      name: "nextAuctionId",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
  ]
  // viem's multicall sends one Multicall3 eth_call for this bounded house set.
  const results = await client.multicall({
    contracts: houses.map((row) => ({
      address: row.house,
      abi,
      functionName: "nextAuctionId",
    })),
    allowFailure: true,
    batchSize: 65_536,
  })
  const mismatches = []
  for (let i = 0; i < houses.length; i++) {
    const result = results[i]
    if (result.status !== "success") {
      mismatches.push(`${houses[i].house}: onchain read failed`)
      continue
    }
    const onchain = Number(result.result)
    if (onchain !== houses[i].indexed) {
      mismatches.push(
        `${houses[i].house}: onchain=${onchain}, indexed=${houses[i].indexed}`,
      )
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Auction parity failed for ${mismatches.length}/${houses.length} houses: ` +
        mismatches.slice(0, 10).join("; "),
    )
  }
}

function knownArtistsViewSql() {
  const live = quoteIdent(ALIAS_SCHEMA)
  return `CREATE OR REPLACE VIEW public.known_artists AS
WITH ecosystem_signals(address) AS (
  SELECT lower(owner) FROM ${live}.pnd_houses
  UNION SELECT lower(creator) FROM ${live}.fnd_collections
  UNION SELECT lower(address) FROM ${live}.mint_creators
  UNION SELECT lower(artist) FROM ${live}.catalog_contracts
  UNION SELECT lower(artist) FROM ${live}.catalog_tokens
  UNION SELECT lower(artist) FROM ${live}.catalog_ranges
  UNION SELECT lower(owner) FROM ${live}.collections
  UNION SELECT lower(address) FROM public.artist_seeds
)
SELECT address FROM ecosystem_signals
UNION
SELECT DISTINCT lower(t.sender)
FROM ${live}.tl_creators t
WHERE t.c_type LIKE 'ERC721%'
  AND EXISTS (
    SELECT 1 FROM ecosystem_signals e WHERE e.address = lower(t.sender)
  )`
}

async function currentState(sql) {
  const rows = await sql`
    SELECT active_schema, previous_schema, build_id, table_counts
    FROM public.indexer_state WHERE singleton = TRUE LIMIT 1
  `
  if (!rows[0]) throw new Error("public.indexer_state is missing; run db:migrate")
  return rows[0]
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
})

try {
  const state = await currentState(sql)
  const baselineSchema = state.active_schema ?? args.from
  if (!state.active_schema && !args.from) {
    throw new Error("Initial cutover requires --from <current live schema>")
  }
  if (state.active_schema && args.from && args.from !== state.active_schema) {
    throw new Error(
      `--from ${args.from} disagrees with active schema ${state.active_schema}`,
    )
  }
  if (args.rollback && args.target !== state.previous_schema) {
    throw new Error(
      `Rollback target must be previous schema ${state.previous_schema ?? "(none)"}`,
    )
  }

  const targetMeta = await readMeta(sql, args.target)
  await validateTables(sql, args.target, targetMeta)
  const targetTables = [...new Set(targetMeta.table_names)].sort()
  const targetCounts = await countTables(sql, args.target, targetTables)
  await resolveFactory(sql, args.target)

  if (args.rollback) {
    const snapshots = await sql`
      SELECT table_counts FROM public.indexer_schema_snapshots
      WHERE schema_name = ${args.target} LIMIT 1
    `
    if (!snapshots[0]) {
      throw new Error(`No prior cutover snapshot exists for ${args.target}`)
    }
    assertNoRegression(targetCounts, snapshots[0].table_counts, args.target)
  } else {
    // The replacement indexer owns the target lock. The prior schema is
    // expected to be unlocked after its process stops, but must remain ready
    // and complete enough to serve as the row-count baseline.
    const baselineMeta = await readMeta(sql, baselineSchema, {
      requireLocked: baselineSchema === args.target,
    })
    // A fresh build may add tables. The old baseline still has to match its
    // own metadata, but row-count comparison only applies to shared tables.
    await validateTables(sql, baselineSchema, baselineMeta, [])
    const sharedTables = baselineMeta.table_names.filter((table) =>
      targetTables.includes(table),
    )
    const baselineCounts = await countTables(sql, baselineSchema, sharedTables)
    assertNoRegression(targetCounts, baselineCounts, baselineSchema)
  }

  if (args.verifyAuctions) await verifyAuctionParity(sql, args.target)

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${SWITCH_LOCK}))`

    // Revalidate the readiness bit under the switch lock. Any failure below
    // rolls all aliases and state back together.
    const lockedMeta = await readMeta(tx, args.target)
    if (lockedMeta.build_id !== targetMeta.build_id) {
      throw new Error(`${args.target} build changed during validation`)
    }

    for (const table of ["_ponder_meta", ...targetTables]) {
      await tx.unsafe(
        `CREATE OR REPLACE VIEW ${qualified(ALIAS_SCHEMA, table)} AS ` +
          `SELECT * FROM ${qualified(args.target, table)}`,
      )
    }
    await tx.unsafe(knownArtistsViewSql())

    const countsJson = JSON.stringify(targetCounts)
    await tx`
      INSERT INTO public.indexer_schema_snapshots
        (schema_name, build_id, table_counts, captured_at)
      VALUES
        (${args.target}, ${targetMeta.build_id}, ${countsJson}::jsonb, NOW())
      ON CONFLICT (schema_name) DO UPDATE SET
        build_id = EXCLUDED.build_id,
        table_counts = EXCLUDED.table_counts,
        captured_at = NOW()
    `
    await tx`
      UPDATE public.indexer_state SET
        previous_schema = ${state.active_schema},
        active_schema = ${args.target},
        build_id = ${targetMeta.build_id},
        table_counts = ${countsJson}::jsonb,
        switched_at = NOW(),
        switched_by = ${process.env.USER ?? "unknown"}
      WHERE singleton = TRUE
    `
  })

  console.log(
    `Indexer cutover complete: ${baselineSchema} -> ${args.target} ` +
      `(build ${targetMeta.build_id}, ${targetTables.length} tables)`,
  )
} finally {
  await sql.end()
}
