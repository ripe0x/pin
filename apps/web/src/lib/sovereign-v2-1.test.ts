import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  SOVEREIGN_AUCTION_HOUSE_V2_1_FACTORY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"
import { sovereignV2_1Factory } from "./sovereign-v2-1.ts"

const LOCAL = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"

test("without an override the factory is the @pin/addresses value, null while it is zero", () => {
  // Everything V2.1 in the web app folds off on this null (no reads, no
  // V2.1 deploys, no V2.1 listing rules) until the mainnet deploy fills it.
  const pkg = getAddressOrNull(SOVEREIGN_AUCTION_HOUSE_V2_1_FACTORY, MAINNET_CHAIN_ID)
  assert.equal(sovereignV2_1Factory(undefined), pkg)
  assert.equal(sovereignV2_1Factory(""), pkg)
})

test("NEXT_PUBLIC_SOVEREIGN_V2_1_FACTORY override wins for fork testing", () => {
  assert.equal(sovereignV2_1Factory(LOCAL), LOCAL)
})

test("an invalid or zero override resolves to null instead of falling back", () => {
  assert.equal(sovereignV2_1Factory("0x1234"), null)
  assert.equal(sovereignV2_1Factory("not-an-address"), null)
  assert.equal(sovereignV2_1Factory("0x0000000000000000000000000000000000000000"), null)
})
