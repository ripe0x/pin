/**
 * Run with: pnpm --filter @pin/web exec tsx --test src/lib/release-editorial.test.ts
 *
 * A bad releases.json entry makes loadEditorial drop every entry silently,
 * so this guards the content file and the mintPage entry the venue reads.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { releaseEditorial } from "./release-editorial"
import { resolveMintCollection } from "./mint-collections"

test("releases.json parses and Form of Solitude lists its mint page", () => {
  const fos = releaseEditorial.find((e) => e.slug === "form-of-solitude")
  assert.ok(fos, "entry missing (or the whole file failed to parse)")
  assert.equal(fos.mintPage, "form-of-solitude")
  assert.equal(fos.collection, resolveMintCollection(fos.mintPage!)!.tokenContract!.address)
})
