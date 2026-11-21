import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  checkIndexerFreshness,
  judgeFreshness,
  knownArtistsNeedsRebuild,
  staleThresholdSec,
  syncKnownArtistsSchema,
} from "./startup-checks.ts"

/** Fake postgres client: route by query substring, record every call. */
function fakeSql(routes: Array<[string, (params?: string[]) => unknown]>) {
  const calls: Array<{ query: string; params?: string[] }> = []
  const sql = {
    unsafe: async (query: string, params?: string[]) => {
      calls.push({ query, params })
      for (const [needle, handler] of routes) {
        if (query.includes(needle)) return handler(params)
      }
      throw new Error(`unexpected query: ${query}`)
    },
  }
  return { sql, calls }
}

// The checks log loudly by design; keep test output readable.
for (const k of ["log", "warn", "error"] as const) console[k] = () => {}

test("rebuild only when the view's schema differs from INDEXER_SCHEMA", () => {
  assert.equal(knownArtistsNeedsRebuild("ponder_v4", "ponder_v4"), false)
  assert.equal(knownArtistsNeedsRebuild("ponder_v2", "ponder_v4"), true)
  assert.equal(knownArtistsNeedsRebuild(null, "ponder_v4"), true) // bootstrap view
  assert.equal(knownArtistsNeedsRebuild("ponder_v2,ponder_v4", "ponder_v4"), true)
})

test("syncKnownArtistsSchema rebuilds a view pinned to an old schema", async () => {
  const { sql, calls } = fakeSql([
    ["pnd_known_artists_schema()", () => [{ schema: "ponder_v2" }]],
    ["pnd_rebuild_known_artists", () => [{ pnd_rebuild_known_artists: "ponder_v4" }]],
    ["count(*)", () => [{ n: 103 }]],
  ])
  assert.equal(await syncKnownArtistsSchema(sql, "ponder_v4"), "ponder_v4")
  const rebuild = calls.find((c) => c.query.includes("pnd_rebuild_known_artists"))
  assert.ok(rebuild)
  // The schema goes in as a bind parameter, never spliced into the SQL.
  assert.deepEqual(rebuild.params, ["ponder_v4"])
  assert.ok(!rebuild.query.includes("ponder_v4"))
})

test("syncKnownArtistsSchema is a no-op when the view already matches", async () => {
  const { sql, calls } = fakeSql([
    ["pnd_known_artists_schema()", () => [{ schema: "ponder_v4" }]],
  ])
  assert.equal(await syncKnownArtistsSchema(sql, "ponder_v4"), "ponder_v4")
  assert.equal(calls.length, 1)
})

test("syncKnownArtistsSchema never throws: missing migration", async () => {
  const { sql } = fakeSql([
    ["pnd_known_artists_schema()", () => { throw new Error("function does not exist") }],
  ])
  assert.equal(await syncKnownArtistsSchema(sql, "ponder_v4"), null)
})

test("syncKnownArtistsSchema never throws: rebuild failure keeps the old view", async () => {
  const { sql } = fakeSql([
    ["pnd_known_artists_schema()", () => [{ schema: "ponder_v3" }]],
    ["pnd_rebuild_known_artists", () => { throw new Error("schema has no pnd_houses") }],
  ])
  assert.equal(await syncKnownArtistsSchema(sql, "ponder_v4"), "ponder_v3")
})

test("judgeFreshness classifies age against the threshold", () => {
  const now = 2_000_000_000
  assert.deepEqual(judgeFreshness(now - 60, now, 3600), { status: "fresh", ageSeconds: 60 })
  assert.deepEqual(judgeFreshness(now - 7200, now, 3600), { status: "stale", ageSeconds: 7200 })
  assert.deepEqual(judgeFreshness(null, now, 3600), { status: "unknown" })
  assert.deepEqual(judgeFreshness(0, now, 3600), { status: "unknown" })
  // Clock skew (checkpoint slightly in the future) is fresh, not negative.
  assert.deepEqual(judgeFreshness(now + 5, now, 3600), { status: "fresh", ageSeconds: 0 })
})

test("staleThresholdSec defaults to 6h and honours a positive override", () => {
  assert.equal(staleThresholdSec(undefined), 6 * 3600)
  assert.equal(staleThresholdSec("2"), 2 * 3600)
  assert.equal(staleThresholdSec("nope"), 6 * 3600)
  assert.equal(staleThresholdSec("-1"), 6 * 3600)
})

test("checkIndexerFreshness flags a frozen schema from its checkpoint", async () => {
  const frozen = Math.floor(Date.now() / 1000) - 30 * 86_400
  const { sql } = fakeSql([["_ponder_checkpoint", () => [{ block_ts: String(frozen) }]]])
  const v = await checkIndexerFreshness(sql, "ponder_v1", 6 * 3600)
  assert.equal(v.status, "stale")
})

test("checkIndexerFreshness falls back to auction activity", async () => {
  const recent = Math.floor(Date.now() / 1000) - 120
  const { sql } = fakeSql([
    ["_ponder_checkpoint", () => { throw new Error("relation does not exist") }],
    ["pnd_auctions", () => [{ block_ts: recent }]],
  ])
  const v = await checkIndexerFreshness(sql, "ponder_v4", 6 * 3600)
  assert.equal(v.status, "fresh")
})

test("checkIndexerFreshness reports unknown, never throws, when nothing is readable", async () => {
  const { sql } = fakeSql([])
  const v = await checkIndexerFreshness(sql, "ponder_v9", 6 * 3600)
  assert.equal(v.status, "unknown")
})
