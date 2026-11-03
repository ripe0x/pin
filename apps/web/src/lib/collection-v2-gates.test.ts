/**
 * The Surface v2 rebind's pure decisions: lifecycle status (a closed sale is
 * Closed even with a future mintStart), which collections take the
 * primitive-first v2 read (proof of origin, never version() alone), which
 * minter the collection page's CTA gets (v1 unchanged by the v2 sale read),
 * the version-aware renderer-permanence copy, and the single no-referral
 * list both mint surfaces read.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  SurfaceStatus,
  ZERO_ADDRESS,
  decodeSaleV2Config,
  isMintable,
  isPrimitiveV2IndexedRow,
  isPrimitiveV2Live,
  lifecycleStatus,
  mintCtaMinter,
  mintReferrerFor,
  rendererPermanenceCopy,
  saleWindowOf,
  type MinterSaleConfig,
} from "./collection.ts"
import { NO_REFERRAL_COLLECTIONS, isNoReferralCollection } from "./referral-exemptions.ts"

const NOW = 1_800_000_000
const FUTURE = BigInt(NOW + 86_400)
const PAST = BigInt(NOW - 86_400)
const MINTER = "0x86a1de6c3136dc5a421ac8372ec9e05e1c533dff" as const

const win = (mintStart: bigint, mintEnd: bigint, supplyCap = 0n) => ({ mintStart, mintEnd, supplyCap })

// ── lifecycleStatus ─────────────────────────────────────────────────────────

test("lifecycleStatus: open, scheduled, ended window, sold out", () => {
  assert.equal(lifecycleStatus(win(0n, 0n), 0n, NOW), SurfaceStatus.Open)
  assert.equal(lifecycleStatus(win(PAST, FUTURE), 0n, NOW), SurfaceStatus.Open)
  assert.equal(lifecycleStatus(win(FUTURE, 0n), 0n, NOW), SurfaceStatus.Scheduled)
  assert.equal(lifecycleStatus(win(FUTURE, FUTURE + 10n), 0n, NOW), SurfaceStatus.Scheduled)
  assert.equal(lifecycleStatus(win(PAST, PAST + 10n), 0n, NOW), SurfaceStatus.Closed)
  assert.equal(lifecycleStatus(win(0n, 0n, 5n), 5n, NOW), SurfaceStatus.Closed)
})

test("lifecycleStatus: an ended window is Closed even when mintStart is ahead", () => {
  assert.equal(lifecycleStatus(win(FUTURE, 1n), 0n, NOW), SurfaceStatus.Closed)
  assert.equal(isMintable(win(FUTURE, 1n), 0n, NOW), false)
})

test("a closed v2 sale scheduled for the future reads Closed, not Scheduled", () => {
  const ok = (result: unknown) => ({ status: "success" as const, result })
  // price, mintStart, mintEnd, payout, maxMints, walletCap, REFERRAL_SHARE_BPS, gate, closed, defaultReferrer
  const sale = decodeSaleV2Config([
    ok(1n),
    ok(FUTURE),
    ok(0n),
    ok(ZERO_ADDRESS),
    ok(0n),
    ok(0n),
    ok(500),
    ok(ZERO_ADDRESS),
    ok(true),
    ok(ZERO_ADDRESS),
  ])
  assert.ok(sale)
  const window = saleWindowOf({ cfg: { supplyCap: 256n } as never, sale })
  assert.equal(lifecycleStatus(window, 0n, NOW), SurfaceStatus.Closed)
})

// ── v2-path gate ────────────────────────────────────────────────────────────

test("isPrimitiveV2IndexedRow: protocol_version 2 counts only from the token-factory schema", () => {
  // Token-factory rows carry a boolean owner_confirmed (renounced or not).
  assert.equal(isPrimitiveV2IndexedRow({ protocolVersion: 2, ownerConfirmed: true }), true)
  assert.equal(isPrimitiveV2IndexedRow({ protocolVersion: 2, ownerConfirmed: false }), true)
  // An older schema's 2 is the superseded SurfaceFactoryV2: no column, or null.
  assert.equal(isPrimitiveV2IndexedRow({ protocolVersion: 2 }), false)
  assert.equal(isPrimitiveV2IndexedRow({ protocolVersion: 2, ownerConfirmed: null }), false)
  assert.equal(isPrimitiveV2IndexedRow({ protocolVersion: 1, ownerConfirmed: null }), false)
  assert.equal(isPrimitiveV2IndexedRow({ protocolVersion: 1 }), false)
})

test("isPrimitiveV2Live: version() 2 alone does not take the v2 path", () => {
  assert.equal(isPrimitiveV2Live({ version: 2, tokenFactoryInstance: true }), true)
  // The superseded Sepolia SurfaceV2: version 2, not a token-factory clone.
  assert.equal(isPrimitiveV2Live({ version: 2, tokenFactoryInstance: false }), false)
  // No token factory configured, or its read failed: stay on the v1 path.
  assert.equal(isPrimitiveV2Live({ version: 2, tokenFactoryInstance: null }), false)
  assert.equal(isPrimitiveV2Live({ version: 1, tokenFactoryInstance: null }), false)
  assert.equal(isPrimitiveV2Live({ version: null, tokenFactoryInstance: true }), false)
})

// ── mint CTA minter ─────────────────────────────────────────────────────────

const someSale = { price: 0n } as MinterSaleConfig

test("mintCtaMinter: v1 keeps its minter whatever the sale read returned", () => {
  assert.equal(mintCtaMinter({ primitiveV2: false, primaryMinter: MINTER, sale: null }), MINTER)
  assert.equal(mintCtaMinter({ primitiveV2: false, primaryMinter: MINTER, sale: someSale }), MINTER)
  assert.equal(mintCtaMinter({ primitiveV2: false, primaryMinter: null, sale: null }), null)
})

test("mintCtaMinter: primitive v2 mints only with a decoded sale", () => {
  assert.equal(mintCtaMinter({ primitiveV2: true, primaryMinter: MINTER, sale: someSale }), MINTER)
  assert.equal(mintCtaMinter({ primitiveV2: true, primaryMinter: MINTER, sale: null }), null)
})

// ── renderer permanence copy ────────────────────────────────────────────────

test("rendererPermanenceCopy: v1 talks about the lock", () => {
  assert.match(rendererPermanenceCopy({ primitiveV2: false, isRendererLocked: false, sealed: false }), /until the artist locks it/)
  assert.match(rendererPermanenceCopy({ primitiveV2: false, isRendererLocked: true, sealed: false }), /renderer is locked/)
})

test("rendererPermanenceCopy: primitive v2 talks about renounced ownership", () => {
  assert.equal(
    rendererPermanenceCopy({ primitiveV2: true, isRendererLocked: false, sealed: false }),
    "The artist can change the renderer until they renounce ownership of the collection.",
  )
  assert.equal(
    rendererPermanenceCopy({ primitiveV2: true, isRendererLocked: true, sealed: true }),
    "Ownership is renounced: the renderer can no longer change.",
  )
})

// ── the one no-referral list ────────────────────────────────────────────────

test("NO_REFERRAL_COLLECTIONS is the list mintReferrerFor reads", () => {
  assert.ok(NO_REFERRAL_COLLECTIONS.size > 0)
  for (const collection of NO_REFERRAL_COLLECTIONS) {
    assert.equal(collection, collection.toLowerCase())
    assert.equal(isNoReferralCollection(collection.toUpperCase().replace("0X", "0x")), true)
    assert.equal(mintReferrerFor(collection as `0x${string}`, MINTER), ZERO_ADDRESS)
  }
  assert.equal(isNoReferralCollection(MINTER), false)
})
