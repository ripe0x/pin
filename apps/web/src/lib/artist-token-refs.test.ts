import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  ARTIST_TOKEN_SOURCES,
  artistTokenRefsSql,
  artistTokenSourcesSql,
  dedupeArtistTokenRefs,
  type ArtistTokenSourceRow,
} from "./artist-token-refs.ts"

const FND = "0x3b3ee1931dc30c1957379fac9aba94d1c48a5405"
const SR = "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0"

const worker = (contract: string, token_id: string, platform: string, mint_block: number, mint_log_index = 0): ArtistTokenSourceRow =>
  ({ contract, token_id, platform, mint_block: String(mint_block), mint_log_index, src_rank: 0 })
const fndPonder = (token_id: string, mint_block: number, mint_log_index = 0): ArtistTokenSourceRow =>
  ({ contract: FND, token_id, platform: "fnd-shared", mint_block: String(mint_block), mint_log_index, src_rank: 1 })
const srPonder = (token_id: string, mint_block: number): ArtistTokenSourceRow =>
  ({ contract: SR, token_id, platform: "srv2-shared", mint_block: String(mint_block), mint_log_index: 0, src_rank: 2 })

test("an FND shared mint in both the worker and Ponder counts once", () => {
  // Post-FND_START_BLOCK mint: scan-fnd-shared and Ponder both saw it.
  const rows = [
    worker(FND, "100", "fnd-shared", 25_000_000, 7),
    fndPonder("100", 25_000_000, 7),
    fndPonder("101", 25_100_000), // Ponder-only (artist not known yet)
    worker(FND, "50", "fnd-shared", 12_000_000), // pre-window: worker-only
    srPonder("9", 9_000_000),
  ]
  const out = dedupeArtistTokenRefs(rows)
  assert.equal(out.length, 4)
  const keys = out.map((r) => `${r.contract}:${r.token_id}`).sort()
  assert.deepEqual(keys, [`${FND}:100`, `${FND}:101`, `${FND}:50`, `${SR}:9`].sort())
})

test("the worker row wins regardless of input order", () => {
  const a = dedupeArtistTokenRefs([fndPonder("100", 25_000_000), worker(FND, "100", "fnd-shared", 25_000_000)])
  const b = dedupeArtistTokenRefs([worker(FND, "100", "fnd-shared", 25_000_000), fndPonder("100", 25_000_000)])
  assert.equal(a.length, 1)
  assert.equal(a[0].src_rank, 0)
  assert.deepEqual(a, b)
})

test("contract case doesn't defeat the dedupe", () => {
  const out = dedupeArtistTokenRefs([
    worker(FND, "1", "fnd-shared", 1),
    fndPonder("1", 1),
    { ...fndPonder("1", 1), contract: FND.toUpperCase().replace("0X", "0x") },
  ])
  assert.equal(out.length, 1)
})

test("same token id on different contracts are different tokens", () => {
  const out = dedupeArtistTokenRefs([
    worker("0xaaaa", "1", "manifold", 10),
    worker("0xbbbb", "1", "manifold", 11),
  ])
  assert.equal(out.length, 2)
})

test("ties within a rank break on earliest mint position, deterministically", () => {
  const late = { ...fndPonder("5", 200, 3) }
  const early = { ...fndPonder("5", 100, 9) }
  assert.equal(dedupeArtistTokenRefs([late, early])[0], early)
  assert.equal(dedupeArtistTokenRefs([early, late])[0], early)
})

test("surviving rows keep the input's (mint-desc) order", () => {
  const rows = [
    fndPonder("3", 300),
    worker(FND, "2", "fnd-shared", 200),
    fndPonder("2", 200),
    fndPonder("1", 100),
  ]
  assert.deepEqual(dedupeArtistTokenRefs(rows).map((r) => r.token_id), ["3", "2", "1"])
})

test("SQL precedence matches the JS rule (worker < fnd < srv2)", () => {
  assert.deepEqual([...ARTIST_TOKEN_SOURCES], ["artist_tokens", "fnd_artist_tokens", "srv2_artist_tokens"])
  const src = artistTokenSourcesSql("ponder_v4")
  assert.match(src, /0 AS src_rank\s+FROM artist_tokens WHERE artist = \$1/)
  assert.match(src, /log_index, 1\s+FROM ponder_v4\.fnd_artist_tokens/)
  assert.match(src, /log_index, 2\s+FROM ponder_v4\.srv2_artist_tokens/)
  const refs = artistTokenRefsSql("ponder_v4")
  assert.match(refs, /SELECT DISTINCT ON \(s\.contract, s\.token_id\)/)
  // DISTINCT ON keeps the first row per key under this ORDER BY: lowest
  // rank, then earliest mint position, the same as compareRefs.
  assert.match(refs, /ORDER BY s\.contract, s\.token_id, s\.src_rank, s\.mint_block, s\.mint_log_index/)
})
