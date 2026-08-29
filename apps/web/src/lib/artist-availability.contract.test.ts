import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

const availabilitySource = new URL("./artist-availability.ts", import.meta.url)

test("availability ranks the complete inventory before SQL pagination", async () => {
  const text = await readFile(availabilitySource, "utf8")
  const unnest = text.indexOf("FROM unnest(")
  const order = text.indexOf("ORDER BY COALESCE(a.availability_rank")
  const limit = text.indexOf("LIMIT $8 OFFSET $9")
  assert.ok(unnest !== -1 && unnest < order)
  assert.ok(order < limit)
})

test("observed SR and TL availability has a 15 minute freshness gate", async () => {
  const text = await readFile(availabilitySource, "utf8")
  assert.match(text, /OBSERVED_SOURCE_FRESHNESS_MINUTES = 15/)
  assert.equal(
    text.match(/updated_at >= NOW\(\) - INTERVAL '\$\{OBSERVED_SOURCE_FRESHNESS_MINUTES\} minutes'/g)?.length,
    2,
  )
  assert.match(text, /hiddenStaleSources/)
})

test("settling auctions are explicit and excluded from available-now count", async () => {
  const text = await readFile(availabilitySource, "utf8")
  assert.match(text, /"settling"/)
  assert.match(
    text,
    /a\.availability_status IN \('listed', 'active', 'buy-now'\)/,
  )
})
