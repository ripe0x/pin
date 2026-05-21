/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/import-sources/normalize.test.ts
 *
 * Tests for the import-source normalizer. Uses Node's built-in test
 * runner per the convention established by parseEthAmount.test.ts.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { normalize, chunkOps, OPS_PER_TX } from "./normalize.ts"
import type { CatalogOp } from "./types.ts"
import { mapBrinkmanArtwork } from "./brinkman-map.ts"
import type { CatalogSnapshot } from "./normalize.ts"
import type { RawWork } from "./types.ts"

const C1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const
const C2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const

const EMPTY: CatalogSnapshot = { contracts: [], tokens: [], tokenRanges: [] }

function work(partial: Partial<RawWork>): RawWork {
  return {
    id: partial.id ?? "test",
    title: partial.title ?? "Test",
    chainId: partial.chainId ?? 1,
    contract: partial.contract ?? C1,
    ...partial,
  }
}

test("single tokenId from Brinkman-shaped range fields → addToken", () => {
  // Brinkman feed sets tokenIdStart === tokenIdEnd for single 1/1s.
  const raw = mapBrinkmanArtwork({
    slug: "simpler-times",
    title: "simpler times",
    blockchain: "Ethereum",
    contractAddress: "0x93c62cbb28da9207e0acc3f338a6ba4bbb31a8ae",
    tokenIdStart: "14",
    tokenIdEnd: "14",
    tokenId: "14",
  })
  assert.ok(raw && raw.kind === "work")
  const plan = normalize([raw.work], EMPTY)
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0].kind, "addToken")
  if (plan.ops[0].kind === "addToken") {
    assert.equal(plan.ops[0].tokenId, 14n)
  }
})

test("true range (start != end) → addTokenRange", () => {
  // Brinkman "Bull Run": 54200010001..54200010010 inclusive.
  const raw = mapBrinkmanArtwork({
    slug: "bull-run",
    title: "Bull Run",
    blockchain: "Ethereum",
    contractAddress: "0xd6bef1f00b2b8c50b8bb9b97c2bc6c63c0b73da0",
    tokenIdStart: "54200010001",
    tokenIdEnd: "54200010010",
  })
  assert.ok(raw && raw.kind === "work")
  const plan = normalize([raw.work], EMPTY)
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0].kind, "addTokenRange")
  if (plan.ops[0].kind === "addTokenRange") {
    assert.equal(plan.ops[0].start, 54200010001n)
    assert.equal(plan.ops[0].end, 54200010010n)
  }
})

test("non-contiguous tokenIds list → N addToken ops", () => {
  // Brinkman "Awaken Your Inner Child": 20 sampled tokens on a shared
  // contract; not contiguous, so we have to mint N singles.
  const raw = mapBrinkmanArtwork({
    slug: "awaken",
    title: "Awaken Your Inner Child",
    blockchain: "Ethereum",
    contractAddress: "0x3bd07e536893db78392141714f2a810c9c997e1d",
    tokenId: "79",
    tokenIds: ["79", "233", "121"],
    edition: "Edition of 20",
  })
  assert.ok(raw && raw.kind === "work")
  const plan = normalize([raw.work], EMPTY)
  assert.equal(plan.ops.length, 3)
  for (const op of plan.ops) assert.equal(op.kind, "addToken")
  const ids = plan.ops
    .map((o) => (o.kind === "addToken" ? o.tokenId : 0n))
    .sort((a, b) => Number(a - b))
  assert.deepEqual(ids, [79n, 121n, 233n])
})

test("non-mainnet works → nonMainnet bucket, no ops", () => {
  const polygon = mapBrinkmanArtwork({
    slug: "polygon-work",
    title: "Insecurity Camera",
    blockchain: "Polygon",
    contractAddress: "0x5a494287d8ad3eaa628578ba9e6688c32f34952f",
    tokenId: "1",
  })
  const base = mapBrinkmanArtwork({
    slug: "base-work",
    title: "Battery Life",
    blockchain: "Base",
    contractAddress: "0x658e4dad7e206f662692bf913db33cf7a213565e",
    tokenId: "1",
  })
  assert.ok(polygon && polygon.kind === "work")
  assert.ok(base && base.kind === "work")
  const plan = normalize([polygon.work, base.work], EMPTY)
  assert.equal(plan.ops.length, 0)
  assert.equal(plan.nonMainnet.length, 2)
})

test("off-chain platforms (Flow/Bitcoin/Tezos) → mapper classifies as skip", () => {
  const flow = mapBrinkmanArtwork({
    slug: "flow",
    title: "Cloudy Thoughts",
    blockchain: "Flow",
    contractAddress: undefined,
    tokenId: undefined,
  })
  const bitcoin = mapBrinkmanArtwork({
    slug: "btc",
    title: "FL1CK3R",
    blockchain: "Bitcoin",
    contractAddress: undefined,
  })
  assert.ok(flow && flow.kind === "skip")
  assert.equal(flow.skip.reason, "non-evm-chain")
  assert.ok(bitcoin && bitcoin.kind === "skip")
  assert.equal(bitcoin.skip.reason, "non-evm-chain")
})

test("physical entry (no blockchain set, no contract) → mapper classifies as physical", () => {
  const physical = mapBrinkmanArtwork({
    slug: "phys",
    title: "Head In The Clouds",
    blockchain: undefined,
    contractAddress: undefined,
  })
  assert.ok(physical && physical.kind === "skip")
  assert.equal(physical.skip.reason, "physical")
})

test("physical work (no tokenId, no list, no range) → unparseable", () => {
  // Build the RawWork manually since the Brinkman mapper drops these
  // upstream. The normalizer should still treat them as unparseable if
  // an adapter ever lets one through.
  const w = work({
    id: "physical",
    title: "Physical print",
    contract: C1,
    chainId: 1,
  })
  const plan = normalize([w], EMPTY)
  assert.equal(plan.ops.length, 0)
  assert.equal(plan.unparseable.length, 1)
})

test("dedup: contract already in existing.contracts → all drop", () => {
  const w1 = work({ id: "a", contract: C1, tokenId: 1n })
  const w2 = work({ id: "b", contract: C1, tokenIdStart: 10n, tokenIdEnd: 15n })
  const w3 = work({ id: "c", contract: C2, tokenId: 99n })
  const plan = normalize([w1, w2, w3], {
    contracts: [C1],
    tokens: [],
    tokenRanges: [],
  })
  assert.equal(plan.alreadyIndexed.length, 2)
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0].contract, C2)
})

test("dedup: single token already in existing.tokens → drops", () => {
  const w = work({ contract: C1, tokenId: 42n })
  const plan = normalize([w], {
    contracts: [],
    tokens: [{ contractAddress: C1, tokenId: "42" }],
    tokenRanges: [],
  })
  assert.equal(plan.ops.length, 0)
  assert.equal(plan.alreadyIndexed.length, 1)
})

test("dedup: token falling inside an existing range → drops", () => {
  const w = work({ contract: C1, tokenId: 50n })
  const plan = normalize([w], {
    contracts: [],
    tokens: [],
    tokenRanges: [
      { contractAddress: C1, startTokenId: "40", endTokenId: "60" },
    ],
  })
  assert.equal(plan.ops.length, 0)
})

test("range partial-overlap: existing covers start → trims to remainder", () => {
  // Existing covers [10..15]; proposed [10..20] → keep [16..20] as range.
  const w = work({ contract: C1, tokenIdStart: 10n, tokenIdEnd: 20n })
  const plan = normalize([w], {
    contracts: [],
    tokens: [],
    tokenRanges: [
      { contractAddress: C1, startTokenId: "10", endTokenId: "15" },
    ],
  })
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0].kind, "addTokenRange")
  if (plan.ops[0].kind === "addTokenRange") {
    assert.equal(plan.ops[0].start, 16n)
    assert.equal(plan.ops[0].end, 20n)
  }
})

test("range partial-overlap: existing punches hole → splits into 2 ops", () => {
  // Proposed [1..20], existing [10..12] → emit [1..9] + [13..20].
  const w = work({ contract: C1, tokenIdStart: 1n, tokenIdEnd: 20n })
  const plan = normalize([w], {
    contracts: [],
    tokens: [],
    tokenRanges: [
      { contractAddress: C1, startTokenId: "10", endTokenId: "12" },
    ],
  })
  assert.equal(plan.ops.length, 2)
  if (
    plan.ops[0].kind === "addTokenRange" &&
    plan.ops[1].kind === "addTokenRange"
  ) {
    assert.equal(plan.ops[0].start, 1n)
    assert.equal(plan.ops[0].end, 9n)
    assert.equal(plan.ops[1].start, 13n)
    assert.equal(plan.ops[1].end, 20n)
  } else {
    assert.fail("expected two addTokenRange ops")
  }
})

test("range trimmed to single → emits addToken not addTokenRange", () => {
  // Proposed [10..11], existing covers 10 → uncovered is [11..11], emit
  // addToken(11) rather than addTokenRange(11,11) (cheaper gas).
  const w = work({ contract: C1, tokenIdStart: 10n, tokenIdEnd: 11n })
  const plan = normalize([w], {
    contracts: [],
    tokens: [{ contractAddress: C1, tokenId: "10" }],
    tokenRanges: [],
  })
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0].kind, "addToken")
  if (plan.ops[0].kind === "addToken") {
    assert.equal(plan.ops[0].tokenId, 11n)
  }
})

test("preserves source input order of contracts (adapter controls ordering)", () => {
  // normalize() no longer imposes an alphabetical sort on contracts —
  // adapters (e.g. pnd-indexed orders by recency-of-first-mint DESC)
  // get to decide the order. Within a contract, range-before-single
  // and token-id ascending still apply.
  const w1 = work({ id: "b", contract: C2, tokenId: 1n })
  const w2 = work({ id: "a", contract: C1, tokenId: 1n })
  const plan = normalize([w1, w2], EMPTY)
  // C2 was first in input → first in output, regardless of alpha order.
  assert.equal(plan.ops[0].contract, C2)
  assert.equal(plan.ops[1].contract, C1)
})

test("intra-list duplicates collapse into a single op", () => {
  // Source feed lists the same (contract, tokenId) twice — e.g. two
  // slugs both pointing at SuperRare V2 token 16926. Should emit one
  // addToken op, not two (avoids on-chain revert AND React key clash).
  const w1 = work({ id: "slug-a", title: "First slug", contract: C1, tokenId: 7n })
  const w2 = work({ id: "slug-b", title: "Second slug", contract: C1, tokenId: 7n })
  const plan = normalize([w1, w2], EMPTY)
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0].works.length, 2)
})

test("addContract op variant: chunk and tokenCount logic accepts it", () => {
  // Sanity that chunkOps treats addContract as a normal op (1 inner call).
  // The planner builds these on the fly when the artist toggles a
  // contract to "whole" mode — normalize() itself never emits them.
  const op: CatalogOp = {
    kind: "addContract" as const,
    contract: C1,
    works: [],
  }
  const chunks = chunkOps([op])
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].length, 1)
  assert.equal(chunks[0][0].kind, "addContract")
})

test("chunkOps splits at OPS_PER_TX boundary", () => {
  const ops = Array.from({ length: OPS_PER_TX * 2 + 7 }, (_, i) =>
    ({
      kind: "addToken" as const,
      contract: C1,
      tokenId: BigInt(i),
      works: [],
    }),
  )
  const chunks = chunkOps(ops)
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].length, OPS_PER_TX)
  assert.equal(chunks[1].length, OPS_PER_TX)
  assert.equal(chunks[2].length, 7)
})
