import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { DEFAULT_INDEXER_SCHEMA, sanitizeSchemaName } from "./indexer-schema.ts"

test("default schema is the live schema, not a dead one", () => {
  assert.equal(DEFAULT_INDEXER_SCHEMA, "ponder_v4")
  assert.notEqual(DEFAULT_INDEXER_SCHEMA, "ponder_v1")
  assert.notEqual(DEFAULT_INDEXER_SCHEMA, "ponder_v2")
  assert.notEqual(DEFAULT_INDEXER_SCHEMA, "ponder_v3") // rollback pair, not live
})

test("worker, web and the build guard agree on the default schema", () => {
  // The three copies can't import each other (web's module is bundled by
  // Next, the guard is a plain .mjs that runs before the build), so pin
  // them together here: bumping one without the others fails CI.
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const defaultIn = (rel: string) => {
    const src = readFileSync(join(root, rel), "utf8")
    const m = src.match(/DEFAULT_INDEXER_SCHEMA = "([A-Za-z0-9_]+)"/)
    assert.ok(m, `no DEFAULT_INDEXER_SCHEMA in ${rel}`)
    return m[1]
  }
  assert.equal(defaultIn("apps/web/src/lib/indexer-schema.ts"), DEFAULT_INDEXER_SCHEMA)
  assert.equal(defaultIn("scripts/check-indexer-schema.mjs"), DEFAULT_INDEXER_SCHEMA)
})

test("sanitize passes through a plain identifier unchanged", () => {
  assert.equal(sanitizeSchemaName("ponder_v4"), "ponder_v4")
})

test("sanitize strips SQL-injection-shaped characters", () => {
  assert.equal(
    sanitizeSchemaName("ponder_v4; DROP TABLE users;--"),
    "ponder_v4DROPTABLEusers",
  )
})

test("sanitize strips quotes, dots, and whitespace", () => {
  assert.equal(sanitizeSchemaName(`public"."evil`), "publicevil")
  assert.equal(sanitizeSchemaName("has space"), "hasspace")
})

test("sanitize keeps underscores and digits (real schema-name shape)", () => {
  assert.equal(sanitizeSchemaName("ponder_v10"), "ponder_v10")
})
