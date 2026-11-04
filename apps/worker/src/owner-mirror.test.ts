import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  FND_START_BLOCK, buildOwnerMirrorSql, mirrorSource, nextMirrorCursor, ownerMirrorParams,
  ownerMirrorWins, ownerOfGapCandidatesSql, type OwnerObservation,
} from "./owner-mirror.ts"

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const SR = mirrorSource("superrare-v2")

const obs = (owner: string, block: bigint, logIndex: bigint, source: string | null): OwnerObservation =>
  ({ owner, block, logIndex, source })

test("Ponder evidence replaces the ownerOf-at-mint row (block 0)", () => {
  assert.equal(ownerMirrorWins(obs(A, 0n, -1n, null), obs(B, 25_000_000n, 4n, SR)), true)
  assert.equal(ownerMirrorWins(obs(A, 0n, -1n, "ownerof"), obs(B, 25_000_000n, 4n, SR)), true)
})

test("a token with no row gets one", () => {
  assert.equal(ownerMirrorWins(null, obs(B, 1n, 0n, SR)), true)
})

test("an older observation never replaces a newer one", () => {
  assert.equal(ownerMirrorWins(obs(B, 200n, 0n, SR), obs(A, 100n, 9n, SR)), false)
  // Same block: log index decides.
  assert.equal(ownerMirrorWins(obs(B, 200n, 5n, SR), obs(A, 200n, 4n, SR)), false)
  assert.equal(ownerMirrorWins(obs(B, 200n, 4n, SR), obs(A, 200n, 5n, SR)), true)
})

test("a later transfer in the same block wins over a legacy same-block row", () => {
  // Legacy writers stored log index -1 (unknown).
  assert.equal(ownerMirrorWins(obs(A, 200n, -1n, null), obs(B, 200n, 0n, SR)), true)
})

test("replaying the identical row is a no-op", () => {
  assert.equal(ownerMirrorWins(obs(B, 200n, 4n, SR), obs(B, 200n, 4n, SR)), false)
})

test("same position from another writer is relabelled, not ignored", () => {
  assert.equal(ownerMirrorWins(obs(B, 200n, 4n, null), obs(B, 200n, 4n, SR)), true)
})

test("cursor follows what Ponder has written, never past the safe head or backwards", () => {
  assert.equal(nextMirrorCursor(null, null, 1_000n), null)
  assert.equal(nextMirrorCursor(500n, null, 1_000n), 500n)
  assert.equal(nextMirrorCursor(null, 700n, 1_000n), 700n)
  assert.equal(nextMirrorCursor(500n, 400n, 1_000n), 500n) // replay overlap only
  assert.equal(nextMirrorCursor(500n, 2_000n, 1_000n), 1_000n)
})

test("a truncated pass stops one block short of its last (maybe partial) block", () => {
  assert.equal(nextMirrorCursor(null, 700n, 1_000n, true), 699n)
  assert.equal(nextMirrorCursor(699n, 700n, 1_000n, true), 699n)
})

test("mirror SQL encodes the same precedence and only finalized rows", () => {
  for (const mode of ["incremental", "late-tracked", "reconcile"] as const) {
    const q = buildOwnerMirrorSql("ponder_v5", mode)
    assert.match(q, /\(token_owners\.transferred_at_block, token_owners\.transferred_at_log_index\)\s+<= \(EXCLUDED\.transferred_at_block, EXCLUDED\.transferred_at_log_index\)/)
    assert.match(q, /IS DISTINCT FROM/)
    assert.match(q, /ponder_v5\.token_ownership o/)
    assert.match(q, /ponder_v5\.srv2_artist_tokens s WHERE s\.id = o\.id/)
    assert.match(q, /ponder_v5\.fnd_artist_tokens f WHERE f\.id = o\.id/)
    assert.match(q, /LIMIT \$\d::int/)
  }
  assert.match(buildOwnerMirrorSql("ponder_v5", "incremental"), /o\.last_block >= \$1::numeric AND o\.last_block <= \$2::numeric/)
  assert.match(buildOwnerMirrorSql("ponder_v5", "reconcile"), /o\.last_block <= \$1::numeric/)
  assert.deepEqual(ownerMirrorParams("incremental", 10n, 20n, 5), ["10", "20", "5"])
  assert.deepEqual(ownerMirrorParams("reconcile", 10n, 20n, 5), ["20", "5"])
})

test("ownerOf gap fill is limited to pre-FND_START tokens with no evidence", () => {
  const q = ownerOfGapCandidatesSql("ponder_v5")
  assert.match(q, /a\.mint_block < \$2::bigint/)
  assert.match(q, /NOT EXISTS \(\s*SELECT 1 FROM public\.token_owners t/)
  assert.match(q, /NOT EXISTS \(\s*SELECT 1 FROM ponder_v5\.token_ownership o/)
  assert.match(q, /b\.retry_at IS NULL OR b\.retry_at <= NOW\(\)/)
  assert.equal(FND_START_BLOCK, 24_973_294n)
})
