/**
 * Surface v2 (primitive-first) sale decoding and the mint referrer rule:
 * every PND mint pays PND's referral share except the collections listed in
 * NO_REFERRAL_COLLECTIONS, and an unset PND referrer env falls back to the
 * sale's own defaultReferrer rather than to nobody.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { ZERO_ADDRESS, decodeSaleV2Config, mintReferrerFor } from "./collection.ts"

const FORM_OF_SOLITUDE = "0x4490F1DADEFA3234961404F5CC58056296EB4A89"
const OTHER = "0x7154b8df00000000000000000000000000000001"
const SALE_DEFAULT = "0xea194A186EBe76A84E2B2027f5f23F81939c05AD"
const PND = "0x2222222222222222222222222222222222222222"
const ENV = "NEXT_PUBLIC_PND_REFERRAL_ADDRESS"

const ok = (result: unknown) => ({ status: "success" as const, result })
// price, mintStart, mintEnd, payout, maxMints, walletCap, REFERRAL_SHARE_BPS, gate, closed, defaultReferrer
const saleReads = (over: Partial<Record<"gate" | "closed", unknown>> = {}) => [
  ok(25_000_000_000_000_000n),
  ok(1793721600n),
  ok(0n),
  ok("0x365C231A37e1De128E62CF173923A7fBae785860"),
  ok(0n),
  ok(0n),
  ok(500),
  ok(over.gate ?? ZERO_ADDRESS),
  ok(over.closed ?? false),
  ok(SALE_DEFAULT),
]

test("decodeSaleV2Config maps the FixedPriceSale getters", () => {
  const s = decodeSaleV2Config(saleReads())
  assert.ok(s)
  assert.equal(s.price, 25_000_000_000_000_000n)
  assert.equal(s.mintStart, 1793721600n)
  assert.equal(s.mintEnd, 0n)
  assert.equal(s.referralShareBps, 500)
  assert.equal(s.priceStrategy, ZERO_ADDRESS)
  assert.equal(s.defaultReferrer, SALE_DEFAULT)
})

test("decodeSaleV2Config: a closed sale reads as an ended window", () => {
  assert.equal(decodeSaleV2Config(saleReads({ closed: true }))?.mintEnd, 1n)
})

test("decodeSaleV2Config: gated or failed reads give no buy flow", () => {
  assert.equal(decodeSaleV2Config(saleReads({ gate: PND })), null)
  const failed = saleReads()
  failed[0] = { status: "failure" } as never
  assert.equal(decodeSaleV2Config(failed), null)
  assert.equal(decodeSaleV2Config(saleReads().slice(0, 9)), null)
})

test("mintReferrerFor: Form of Solitude passes zero, any case", () => {
  process.env[ENV] = PND
  assert.equal(mintReferrerFor(FORM_OF_SOLITUDE as `0x${string}`, SALE_DEFAULT), ZERO_ADDRESS)
  assert.equal(mintReferrerFor(FORM_OF_SOLITUDE.toLowerCase() as `0x${string}`, SALE_DEFAULT), ZERO_ADDRESS)
  delete process.env[ENV]
})

test("mintReferrerFor: other collections pay PND, else the sale default", () => {
  process.env[ENV] = PND
  assert.equal(mintReferrerFor(OTHER as `0x${string}`, SALE_DEFAULT), PND)
  delete process.env[ENV]
  assert.equal(mintReferrerFor(OTHER as `0x${string}`, SALE_DEFAULT), SALE_DEFAULT)
  assert.equal(mintReferrerFor(OTHER as `0x${string}`), ZERO_ADDRESS)
})
