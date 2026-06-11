/**
 * Run with: node --experimental-strip-types --test packages/shared/src/ipfs.test.ts
 *
 * Tests live alongside the utilities they cover, using Node's built-in
 * test runner + native TypeScript stripping (Node 22+) — same convention
 * as apps/web/src/lib/parseEthAmount.test.ts.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { extractBareCid, extractCid } from "./ipfs.ts"

const CID_V0 = "QmeKwk8yZDCAbkvCxgMzNsjqAujwgzqvn6R1aVMbVKhNaz"
const CID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
const PATH = "0x2963ba471e265e5f51cafafca78310fe87f8e6d1"

// Real-world malformed form from Foundation shared-contract mints: the
// minter pasted a full HTTPS gateway URL into the field the contract
// prefixes with ipfs:// (e.g. tokenURI(133282) on
// 0x3b3ee1931dc30c1957379fac9aba94d1c48a5405).
const NESTED_WITH_PATH = `ipfs://https://ipfs.io/ipfs/${CID_V0}/${PATH}`
const NESTED_NO_PATH = `ipfs://https://ipfs.io/ipfs/${CID_V0}`

test("extractCid: plain ipfs://<cid>", () => {
  assert.equal(extractCid(`ipfs://${CID_V0}`), CID_V0)
  assert.equal(extractCid(`ipfs://${CID_V1}`), CID_V1)
})

test("extractCid: ipfs://<cid>/<path> preserves the path", () => {
  assert.equal(extractCid(`ipfs://${CID_V0}/${PATH}`), `${CID_V0}/${PATH}`)
})

test("extractCid: ipfs://ipfs/<cid> (Foundation double-prefix)", () => {
  assert.equal(extractCid(`ipfs://ipfs/${CID_V0}`), CID_V0)
})

test("extractCid: nested https gateway URL with path", () => {
  assert.equal(extractCid(NESTED_WITH_PATH), `${CID_V0}/${PATH}`)
})

test("extractCid: nested https gateway URL without path", () => {
  assert.equal(extractCid(NESTED_NO_PATH), CID_V0)
})

test("extractCid: nested http:// gateway URL", () => {
  assert.equal(extractCid(`ipfs://http://ipfs.io/ipfs/${CID_V0}`), CID_V0)
})

test("extractCid: plain https gateway URL still works", () => {
  assert.equal(
    extractCid(`https://ipfs.io/ipfs/${CID_V0}/${PATH}`),
    `${CID_V0}/${PATH}`,
  )
})

test("extractCid: nested https URL with no /ipfs/ segment is null", () => {
  assert.equal(extractCid("ipfs://https://example.com/foo.png"), null)
})

test("extractCid: non-IPFS URIs are null", () => {
  assert.equal(extractCid("https://example.com/foo.png"), null)
  assert.equal(extractCid("ar://abc"), null)
  assert.equal(extractCid("ipfs://"), null)
})

test("extractBareCid: plain ipfs://<cid>", () => {
  assert.equal(extractBareCid(`ipfs://${CID_V0}`), CID_V0)
  assert.equal(extractBareCid(`ipfs://${CID_V1}`), CID_V1)
})

test("extractBareCid: ipfs://<cid>/<path> drops the path", () => {
  assert.equal(extractBareCid(`ipfs://${CID_V0}/${PATH}`), CID_V0)
})

test("extractBareCid: ipfs://ipfs/<cid> (Foundation double-prefix)", () => {
  assert.equal(extractBareCid(`ipfs://ipfs/${CID_V0}`), CID_V0)
})

test("extractBareCid: nested https gateway URL with path", () => {
  assert.equal(extractBareCid(NESTED_WITH_PATH), CID_V0)
})

test("extractBareCid: nested https gateway URL without path", () => {
  assert.equal(extractBareCid(NESTED_NO_PATH), CID_V0)
})

test("extractBareCid: nested URL whose CID slot is not a CID is null", () => {
  assert.equal(
    extractBareCid("ipfs://https://example.com/ipfs/not-a-cid"),
    null,
  )
})

test("extractBareCid: path and subdomain gateways still work", () => {
  assert.equal(extractBareCid(`https://ipfs.io/ipfs/${CID_V0}`), CID_V0)
  assert.equal(
    extractBareCid(`https://${CID_V1}.ipfs.dweb.link/foo.png`),
    CID_V1,
  )
})

test("extractBareCid: null / empty / non-IPFS inputs are null", () => {
  assert.equal(extractBareCid(null), null)
  assert.equal(extractBareCid(""), null)
  assert.equal(extractBareCid("https://example.com/foo.png"), null)
})
