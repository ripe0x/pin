import { strict as assert } from "node:assert"
import { test } from "node:test"
import { DEFAULT_INDEXER_SCHEMA, sanitizeSchemaName } from "./indexer-schema.ts"

test("default schema is the live schema, not a dead one", () => {
  assert.equal(DEFAULT_INDEXER_SCHEMA, "ponder_v3")
  assert.notEqual(DEFAULT_INDEXER_SCHEMA, "ponder_v1")
  assert.notEqual(DEFAULT_INDEXER_SCHEMA, "ponder_v2")
})

test("sanitize passes through a plain identifier unchanged", () => {
  assert.equal(sanitizeSchemaName("ponder_v3"), "ponder_v3")
})

test("sanitize strips SQL-injection-shaped characters", () => {
  assert.equal(
    sanitizeSchemaName("ponder_v3; DROP TABLE users;--"),
    "ponder_v3DROPTABLEusers",
  )
})

test("sanitize strips quotes, dots, and whitespace", () => {
  assert.equal(sanitizeSchemaName(`public"."evil`), "publicevil")
  assert.equal(sanitizeSchemaName("has space"), "hasspace")
})

test("sanitize keeps underscores and digits (real schema-name shape)", () => {
  assert.equal(sanitizeSchemaName("ponder_v10"), "ponder_v10")
})
