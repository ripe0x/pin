/**
 * Run with: pnpm --filter @pin/web exec tsx --test src/lib/mint-modules/form-of-solitude.test.ts
 *
 * Form of Solitude is the one collection exempt from PND's 5% referral: its
 * mint must call mintWithReferral with a zero referrer and the chosen quantity.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { zeroAddress, type PublicClient } from "viem"
import { resolveMintCollection } from "../mint-collections"
import { getArgsBuilder } from "../mint-registries"

const WALLET = "0x00000000000000000000000000000000000A11CE"

test("resolves by slug and by sale address, on mainnet", () => {
  const bySlug = resolveMintCollection("form-of-solitude")
  assert.ok(bySlug)
  assert.equal(bySlug.chainId, 1)
  assert.equal(resolveMintCollection("0x86A1DE6C3136DC5A421AC8372EC9E05E1C533DFF")?.slug, "form-of-solitude")
})

test("mints with no referrer and the chosen quantity", async () => {
  const builder = getArgsBuilder(resolveMintCollection("form-of-solitude")!.argsBuilder!)!
  const built = await builder({ client: {} as PublicClient, wallet: WALLET, phaseKey: null, quantity: 3 })
  assert.deepEqual(built, { fn: "mintWithReferral", args: [WALLET, 3n, zeroAddress, "0x"] })
})

test("refuses to build without a wallet", () => {
  const builder = getArgsBuilder("form-of-solitude")!
  assert.throws(() => builder({ client: {} as PublicClient, phaseKey: null, quantity: 1 }), /Connect a wallet/)
})
