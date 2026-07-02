/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/mint-reveal.test.ts
 *
 * Receipt-log → tokenId extraction for the post-mint reveal step. Logs are
 * built with viem's own topic encoders so the fixtures match what a real
 * receipt carries (mint-reveal.ts deliberately imports only viem, so this
 * file runs under Node's test runner without path-alias resolution).
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { encodeEventTopics, parseAbi, toHex, pad } from "viem"
import { extractRevealTokenId, type RevealLog } from "./mint-reveal.ts"

const COLLECTION = "0x1111111111111111111111111111111111111111"
const OTHER_CONTRACT = "0x2222222222222222222222222222222222222222"
const MINTER = "0x3333333333333333333333333333333333333333"
const ZERO = "0x0000000000000000000000000000000000000000"

const erc721Abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
])

// encodeEventTopics' return type allows null entries (unprovided indexed
// args); every fixture here provides all indexed args, so narrow the type.
function asTopics(t: readonly unknown[]): readonly `0x${string}`[] {
  return t as readonly `0x${string}`[]
}

/** A standard ERC-721 Transfer log (all three params indexed → 4 topics). */
function transferLog(opts: {
  address?: string
  from?: string
  to?: string
  tokenId: bigint
}): RevealLog {
  const topics = encodeEventTopics({
    abi: erc721Abi,
    eventName: "Transfer",
    args: { from: (opts.from ?? ZERO) as `0x${string}`, to: (opts.to ?? MINTER) as `0x${string}`, tokenId: opts.tokenId },
  })
  return { address: opts.address ?? COLLECTION, topics: asTopics(topics), data: "0x" }
}

/** An ERC-20-shaped Transfer (amount unindexed → only 3 topics). */
function erc20TransferLog(from: string, to: string): RevealLog {
  const topics = encodeEventTopics({
    abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
    eventName: "Transfer",
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  })
  return { address: COLLECTION, topics: asTopics(topics), data: pad(toHex(1000n)) }
}

// ── transfer-log kind ───────────────────────────────────────────────────────

test("transfer-log: extracts the tokenId from a mint Transfer(from=0)", () => {
  const id = extractRevealTokenId({
    reveal: { kind: "transfer-log" },
    logs: [transferLog({ tokenId: 52n })],
    collection: COLLECTION,
    abi: erc721Abi,
    minter: MINTER,
  })
  assert.equal(id, 52n)
})

test("transfer-log: ignores transfers that are not mints (from != 0)", () => {
  const id = extractRevealTokenId({
    reveal: { kind: "transfer-log" },
    logs: [transferLog({ from: MINTER, to: OTHER_CONTRACT, tokenId: 7n })],
    collection: COLLECTION,
    abi: erc721Abi,
  })
  assert.equal(id, null)
})

test("transfer-log: ignores mints emitted by other contracts", () => {
  const id = extractRevealTokenId({
    reveal: { kind: "transfer-log" },
    logs: [transferLog({ address: OTHER_CONTRACT, tokenId: 7n })],
    collection: COLLECTION,
    abi: erc721Abi,
  })
  assert.equal(id, null)
})

test("transfer-log: collection address match is case-insensitive", () => {
  const id = extractRevealTokenId({
    reveal: { kind: "transfer-log" },
    logs: [transferLog({ tokenId: 9n })],
    collection: COLLECTION.toUpperCase().replace("0X", "0x"),
    abi: erc721Abi,
  })
  assert.equal(id, 9n)
})

test("transfer-log: skips ERC-20-shaped Transfers (3 topics) in the same receipt", () => {
  // A swap-funded mint's receipt carries ERC-20 Transfers with the SAME
  // topic0; the 4-topic ERC-721 shape is the discriminator.
  const id = extractRevealTokenId({
    reveal: { kind: "transfer-log" },
    logs: [erc20TransferLog(ZERO, MINTER), transferLog({ tokenId: 3n })],
    collection: COLLECTION,
    abi: erc721Abi,
  })
  assert.equal(id, 3n)
})

test("transfer-log: minter filter rejects mints to someone else", () => {
  const id = extractRevealTokenId({
    reveal: { kind: "transfer-log" },
    logs: [transferLog({ to: OTHER_CONTRACT, tokenId: 4n })],
    collection: COLLECTION,
    abi: erc721Abi,
    minter: MINTER,
  })
  assert.equal(id, null)
})

test("transfer-log: first mint wins on a multi-token receipt", () => {
  const id = extractRevealTokenId({
    reveal: { kind: "transfer-log" },
    logs: [transferLog({ tokenId: 10n }), transferLog({ tokenId: 11n })],
    collection: COLLECTION,
    abi: erc721Abi,
  })
  assert.equal(id, 10n)
})

test("transfer-log: empty receipt → null", () => {
  const id = extractRevealTokenId({
    reveal: { kind: "transfer-log" },
    logs: [],
    collection: COLLECTION,
    abi: erc721Abi,
  })
  assert.equal(id, null)
})

// ── event kind ──────────────────────────────────────────────────────────────

// Homage-shaped announcement events: an indexed punkId plus other params.
const homageAbi = parseAbi([
  "event Minted(uint256 indexed punkId, address indexed minter, uint256 paid)",
  "event Claimed(uint256 indexed punkId, address indexed claimer)",
])

function mintedLog(punkId: bigint): RevealLog {
  const topics = encodeEventTopics({
    abi: homageAbi,
    eventName: "Minted",
    args: { punkId, minter: MINTER as `0x${string}` },
  })
  return { address: COLLECTION, topics: asTopics(topics), data: pad(toHex(123n)) }
}

test("event: extracts the indexed tokenId-like arg from the named event", () => {
  const id = extractRevealTokenId({
    reveal: { kind: "event", abiEvent: "Minted" },
    logs: [mintedLog(777n)],
    collection: COLLECTION,
    abi: homageAbi,
  })
  assert.equal(id, 777n)
})

test("event: only the NAMED event matches — a Claimed log is not a Minted reveal", () => {
  const claimedTopics = encodeEventTopics({
    abi: homageAbi,
    eventName: "Claimed",
    args: { punkId: 5n, claimer: MINTER as `0x${string}` },
  })
  const id = extractRevealTokenId({
    reveal: { kind: "event", abiEvent: "Minted" },
    logs: [{ address: COLLECTION, topics: asTopics(claimedTopics), data: "0x" }],
    collection: COLLECTION,
    abi: homageAbi,
  })
  assert.equal(id, null)
})

test("event: ignores the named event when another contract emitted it", () => {
  const log = mintedLog(8n)
  const id = extractRevealTokenId({
    reveal: { kind: "event", abiEvent: "Minted" },
    logs: [{ ...log, address: OTHER_CONTRACT }],
    collection: COLLECTION,
    abi: homageAbi,
  })
  assert.equal(id, null)
})

test("event: unknown event name degrades to null instead of throwing", () => {
  const id = extractRevealTokenId({
    reveal: { kind: "event", abiEvent: "Nonexistent" },
    logs: [mintedLog(8n)],
    collection: COLLECTION,
    abi: homageAbi,
  })
  assert.equal(id, null)
})

test("event: falls back to the first uint arg when no *Id-named arg exists", () => {
  const abi = parseAbi(["event Drawn(uint256 indexed seat, address indexed who)"])
  const topics = encodeEventTopics({
    abi,
    eventName: "Drawn",
    args: { seat: 42n, who: MINTER as `0x${string}` },
  })
  const id = extractRevealTokenId({
    reveal: { kind: "event", abiEvent: "Drawn" },
    logs: [{ address: COLLECTION, topics: asTopics(topics), data: "0x" }],
    collection: COLLECTION,
    abi,
  })
  assert.equal(id, 42n)
})
