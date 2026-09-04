import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8")
}

test("1,300 caught-up transfer contracts stay within 18 getLogs requests", async () => {
  const text = await source("./tasks/scan-token-transfers.ts")
  const match = text.match(/const ADDRESS_BATCH_SIZE = (\d+)/)
  assert.ok(match, "transfer scanner must declare an address batch size")
  const batchSize = Number(match[1])

  assert.equal(Math.ceil(1_300 / batchSize), 18)
  assert.match(text, /caughtUp\.slice\(offset, offset \+ ADDRESS_BATCH_SIZE\)/)
  assert.match(text, /address: states\.map\(\(\{ contract \}\) =>/)
})

test("caught-up creator contracts batch mint discovery without recipient bias", async () => {
  const erc721 = await source("./scanners/transfer-from-zero.ts")
  const erc1155 = await source("./scanners/erc1155-mints.ts")
  for (const text of [erc721, erc1155]) {
    const match = text.match(/const ADDRESS_BATCH_SIZE = (\d+)/)
    assert.ok(match)
    assert.equal(Math.ceil(1_300 / Number(match[1])), 18)
  }
  assert.match(erc721, /address: batch\.map/)
  assert.match(erc1155, /const addresses = batch\.map/)
  assert.match(erc1155, /address: addresses/)
  assert.match(erc721, /args: \{ from: ZERO as/)
  assert.doesNotMatch(erc721, /args: \{ from: ZERO as[^}]*to:/)
  assert.match(erc1155, /rpcCalls \+= 2/)
})

test("fixed-contract creator evidence sync is Postgres-only", async () => {
  const text = await source("./tasks/sync-indexed-attributions.ts")
  assert.match(text, /work_attributions/)
  assert.match(text, /fnd_artist_tokens/)
  assert.match(text, /srv2_artist_tokens/)
  assert.doesNotMatch(text, /getLogs|readContract|multicall|getBlock/)
})

test("global SR and TL scanners use one fixed marketplace cursor", async () => {
  for (const file of [
    "./tasks/scan-srv2-active-auctions.ts",
    "./tasks/scan-tl-active-auctions.ts",
  ]) {
    const text = await source(file)
    assert.match(text, /const SCOPE = "global"/)
    assert.match(text, /SELECT address FROM known_artists/)
    assert.match(text, /client\.getLogs\(\{\s*address: [A-Z0-9_]+,/)
    assert.doesNotMatch(text, /for \(const artist of knownArtists\)[\s\S]*client\.getLogs/)
  }
})

test("cursor writes occur only after getLogs and successful multicall validation", async () => {
  const transfer = await source("./tasks/scan-token-transfers.ts")
  assert.ok(transfer.indexOf("client.getLogs") < transfer.indexOf("sql.begin"))
  assert.ok(
    transfer.indexOf("recordErc721Ownership") <
      transfer.lastIndexOf("INSERT INTO worker_cursors"),
  )

  for (const file of [
    "./tasks/scan-srv2-active-auctions.ts",
    "./tasks/scan-tl-active-auctions.ts",
  ]) {
    const text = await source(file)
    assert.ok(text.indexOf("client.getLogs") < text.indexOf("sql.begin"))
    assert.ok(text.indexOf("client.multicall") < text.indexOf("sql.begin"))
    assert.ok(text.indexOf("cursor unchanged") < text.indexOf("sql.begin"))
    assert.ok(text.indexOf("sql.begin") < text.lastIndexOf("INSERT INTO worker_cursors"))
  }
})

test("transfer cursor and ownership writes share the same SQL transaction", async () => {
  const text = await source("./tasks/scan-token-transfers.ts")
  const transaction = text.slice(text.indexOf("await sql.begin"))
  assert.match(transaction, /await recordErc721Ownership\(tx,/)
  assert.match(transaction, /await tx`[\s\S]*INSERT INTO worker_cursors/)
})

test("durable refresh jobs reclaim expired leases and record terminal state", async () => {
  const text = await source("./scheduler.ts")
  assert.match(text, /status = 'running' AND lease_expires_at < NOW\(\)/)
  assert.match(text, /FOR UPDATE SKIP LOCKED/)
  assert.match(text, /attempts = j\.attempts \+ 1/)
  assert.match(text, /lease_expires_at = NOW\(\) \+ INTERVAL '10 minutes'/)
  assert.match(text, /status = \$\{report\.status\}/)
  assert.match(text, /status = 'failed'/)
  assert.match(text, /finished_at = NOW\(\)/)
  assert.match(text, /lease_expires_at = NULL/)
})
