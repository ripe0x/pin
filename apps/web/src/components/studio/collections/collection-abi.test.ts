/**
 * Run with: cd apps/web && ../../node_modules/.bin/tsx --test \
 *   src/components/studio/collections/collection-abi.test.ts
 * (cwd must be apps/web so tsx resolves the "@/*" alias, same as
 * tx-ui.test.ts.) Imports CollectionSettingsPanel.tsx directly — "use
 * client" and JSX in the file don't matter here since only the pure
 * collectionAbi export is exercised, nothing is rendered.
 *
 * collectionAbi picks the write ABI a panel write goes out on: surfaceV2Abi
 * for a v2 collection (adds lockRoyalty/seal/isRoyaltyLocked/permanence over
 * v1), surfaceAbi otherwise. lockRenderer/lockSupply exist on both ABIs with
 * the same selector; lockRoyalty/seal exist only on v2's.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { surfaceAbi, surfaceV2Abi } from "@pin/abi"
import { collectionAbi } from "./CollectionSettingsPanel.tsx"

function hasFunction(abi: readonly unknown[], name: string): boolean {
  return abi.some((e) => (e as { type?: string; name?: string }).type === "function" && (e as { name?: string }).name === name)
}

test("protocolVersion 1 selects surfaceAbi", () => {
  assert.equal(collectionAbi(1), surfaceAbi)
})

test("protocolVersion 2 selects surfaceV2Abi", () => {
  assert.equal(collectionAbi(2), surfaceV2Abi)
})

test("lockRenderer/lockSupply exist on both v1 and v2 ABIs (shared selector)", () => {
  for (const fn of ["lockRenderer", "lockSupply"]) {
    assert.ok(hasFunction(surfaceAbi, fn), `surfaceAbi missing ${fn}`)
    assert.ok(hasFunction(surfaceV2Abi, fn), `surfaceV2Abi missing ${fn}`)
  }
})

test("lockRoyalty/seal exist only on the v2 ABI", () => {
  for (const fn of ["lockRoyalty", "seal"]) {
    assert.equal(hasFunction(surfaceAbi, fn), false, `surfaceAbi should not have ${fn}`)
    assert.ok(hasFunction(surfaceV2Abi, fn), `surfaceV2Abi missing ${fn}`)
  }
})

test("a v1 protocolVersion's ABI has no lockRoyalty/seal, matching the panel's v1 gate", () => {
  const abi = collectionAbi(1)
  assert.equal(hasFunction(abi, "lockRoyalty"), false)
  assert.equal(hasFunction(abi, "seal"), false)
})

test("a v2 protocolVersion's ABI has lockRoyalty/seal, matching the panel's v2-only controls", () => {
  const abi = collectionAbi(2)
  assert.ok(hasFunction(abi, "lockRoyalty"))
  assert.ok(hasFunction(abi, "seal"))
})
