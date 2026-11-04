import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  CURSOR_UPSERT_MANY_SQL, CURSOR_UPSERT_SQL, advanceCursor, advanceCursors,
  nextCursorValue, readCursor, scanWindow,
} from "./cursors.ts"

/** Fake postgres: an in-memory worker_cursors with GREATEST semantics. */
function fakeSql() {
  const table = new Map<string, bigint>()
  const queries: Array<{ q: string; params: string[] }> = []
  const parseArray = (lit: string) =>
    lit.slice(1, -1).split(",").map((s) => s.replace(/^"|"$/g, ""))
  return {
    table,
    queries,
    sql: {
      unsafe: async (q: string, params: string[] = []) => {
        queries.push({ q, params })
        if (q === CURSOR_UPSERT_SQL) {
          const key = `${params[0]}|${params[1]}`
          table.set(key, nextCursorValue(table.get(key) ?? null, BigInt(params[2])))
          return []
        }
        if (q === CURSOR_UPSERT_MANY_SQL) {
          for (const scope of parseArray(params[1])) {
            const key = `${params[0]}|${scope}`
            table.set(key, nextCursorValue(table.get(key) ?? null, BigInt(params[2])))
          }
          return []
        }
        const v = table.get(`${params[0]}|${params[1]}`)
        return v === undefined ? [] : [{ last_block: v.toString() }]
      },
    },
  }
}

test("cursor upserts keep GREATEST(existing, proposed) in SQL", () => {
  for (const q of [CURSOR_UPSERT_SQL, CURSOR_UPSERT_MANY_SQL]) {
    assert.match(q, /ON CONFLICT \(task, scope\) DO UPDATE SET/)
    assert.match(q, /last_block = GREATEST\(worker_cursors\.last_block, EXCLUDED\.last_block\)/)
  }
})

test("nextCursorValue never moves a cursor backwards", () => {
  assert.equal(nextCursorValue(null, 10n), 10n)
  assert.equal(nextCursorValue(10n, 20n), 20n)
  assert.equal(nextCursorValue(20n, 10n), 20n)
  assert.equal(nextCursorValue(20n, 20n), 20n)
})

test("a refresh racing a scheduled run can't rewind the cursor", async () => {
  const { sql, table } = fakeSql()
  await advanceCursor(sql, "scan-tl-clones", "a:b", 1_000n)
  await advanceCursor(sql, "scan-tl-clones", "a:b", 900n) // stale writer
  assert.equal(await readCursor(sql, "scan-tl-clones", "a:b"), 1_000n)
  await advanceCursors(sql, "scan-token-transfers", ["0xa", "0xb"], 50n)
  await advanceCursors(sql, "scan-token-transfers", ["0xa"], 40n)
  assert.equal(table.get("scan-token-transfers|0xa"), 50n)
  assert.equal(table.get("scan-token-transfers|0xb"), 50n)
  assert.equal(await readCursor(sql, "scan-token-transfers", "0xc"), null)
})

test("advanceCursors with no scopes issues no query", async () => {
  const { sql, queries } = fakeSql()
  await advanceCursors(sql, "t", [], 1n)
  assert.equal(queries.length, 0)
})

test("scanWindow: first scan starts at initialFrom", () => {
  assert.deepEqual(scanWindow({ cursor: null, initialFrom: 100n, safeHead: 500n, overlap: 12n }), { from: 100n, to: 500n })
  assert.equal(scanWindow({ cursor: null, initialFrom: 600n, safeHead: 500n }), null)
})

test("scanWindow: resumes with the replay overlap, floored at initialFrom", () => {
  assert.deepEqual(scanWindow({ cursor: 400n, initialFrom: 100n, safeHead: 500n, overlap: 12n }), { from: 389n, to: 500n })
  assert.deepEqual(scanWindow({ cursor: 400n, initialFrom: 100n, safeHead: 500n }), { from: 401n, to: 500n })
  assert.deepEqual(scanWindow({ cursor: 105n, initialFrom: 100n, safeHead: 500n, overlap: 12n }), { from: 100n, to: 500n })
  assert.deepEqual(scanWindow({ cursor: 3n, initialFrom: 0n, safeHead: 500n, overlap: 12n }), { from: 0n, to: 500n })
})

test("scanWindow: an idle scope (cursor at or past the safe head) costs nothing", () => {
  assert.equal(scanWindow({ cursor: 500n, initialFrom: 0n, safeHead: 500n, overlap: 12n }), null)
  // A cursor written at `latest` by older code sits above the new safe head.
  assert.equal(scanWindow({ cursor: 560n, initialFrom: 0n, safeHead: 500n, overlap: 12n }), null)
})
