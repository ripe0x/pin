import { strict as assert } from "node:assert"
import { test } from "node:test"
import { verifyMessage } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  ALLOWLIST_SIGNATURE_TTL_MS,
  buildAllowlistPublishMessage,
  verifyAllowlistPublish,
  type AllowlistAuthDeps,
} from "./allowlist-auth.ts"
import { allowlistRoot } from "./allowlist-tree.ts"

const OWNER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
)
const STRANGER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
)
const COLLECTION = "0xb741055bd0467a5831b8b5f7df376cda93a76af1"
const NOW = Date.parse("2026-11-03T12:00:00.000Z")

const computed = allowlistRoot([
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
])
if ("error" in computed) throw new Error(computed.error)
const ROOT = computed.root

function deps(overrides: Partial<AllowlistAuthDeps> = {}): AllowlistAuthDeps {
  return {
    expectedChainId: 1,
    now: NOW,
    verify: (args) => verifyMessage(args),
    isAuthorized: async (_c, signer) => signer.toLowerCase() === OWNER.address.toLowerCase(),
    ...overrides,
  }
}

async function signed(
  account: typeof OWNER,
  p: { chainId?: number; issuedAt?: string; root?: string; collection?: string } = {},
) {
  const chainId = p.chainId ?? 1
  const issuedAt = p.issuedAt ?? new Date(NOW - 60_000).toISOString()
  const signature = await account.signMessage({
    message: buildAllowlistPublishMessage({
      chainId,
      collection: p.collection ?? COLLECTION,
      root: p.root ?? ROOT,
      issuedAt,
    }),
  })
  return { chainId, issuedAt, signature, signer: account.address }
}

test("owner signature over the exact root verifies", async () => {
  const s = await signed(OWNER)
  const res = await verifyAllowlistPublish({ collection: COLLECTION, root: ROOT, ...s }, deps())
  assert.deepEqual(res, { ok: true, signer: OWNER.address })
})

test("checksummed collection in the URL still matches the signed message", async () => {
  const s = await signed(OWNER)
  const res = await verifyAllowlistPublish(
    { collection: "0xb741055BD0467a5831B8B5f7DF376cdA93a76af1", root: ROOT, ...s },
    deps(),
  )
  assert.equal(res.ok, true)
})

test("a valid signature from a wallet that is not owner/admin is refused", async () => {
  const s = await signed(STRANGER)
  const res = await verifyAllowlistPublish({ collection: COLLECTION, root: ROOT, ...s }, deps())
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.status, 403)
})

test("a signature claimed for the owner but made by another key is refused", async () => {
  const s = await signed(STRANGER)
  const res = await verifyAllowlistPublish(
    { collection: COLLECTION, root: ROOT, ...s, signer: OWNER.address },
    deps(),
  )
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.status, 401)
})

test("a signature over a different list (root) is refused", async () => {
  const s = await signed(OWNER, { root: "0x" + "11".repeat(32) })
  const res = await verifyAllowlistPublish({ collection: COLLECTION, root: ROOT, ...s }, deps())
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.status, 401)
})

test("a signature for another collection is refused", async () => {
  const s = await signed(OWNER, { collection: "0x" + "22".repeat(20) })
  const res = await verifyAllowlistPublish({ collection: COLLECTION, root: ROOT, ...s }, deps())
  assert.equal(res.ok, false)
})

test("expired and far-future issue times are refused", async () => {
  const old = await signed(OWNER, {
    issuedAt: new Date(NOW - ALLOWLIST_SIGNATURE_TTL_MS - 1_000).toISOString(),
  })
  const r1 = await verifyAllowlistPublish({ collection: COLLECTION, root: ROOT, ...old }, deps())
  assert.equal(r1.ok, false)
  if (!r1.ok) assert.match(r1.error, /expired/)

  const future = await signed(OWNER, { issuedAt: new Date(NOW + 10 * 60_000).toISOString() })
  const r2 = await verifyAllowlistPublish({ collection: COLLECTION, root: ROOT, ...future }, deps())
  assert.equal(r2.ok, false)
})

test("a signature for another chain is refused", async () => {
  const s = await signed(OWNER, { chainId: 11155111 })
  const res = await verifyAllowlistPublish({ collection: COLLECTION, root: ROOT, ...s }, deps())
  assert.equal(res.ok, false)
  if (!res.ok) assert.match(res.error, /different chain/)
})

test("missing fields are a 400", async () => {
  const res = await verifyAllowlistPublish(
    { collection: COLLECTION, root: ROOT, chainId: 1, issuedAt: undefined, signer: undefined, signature: undefined },
    deps(),
  )
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.status, 400)
})

test("root is order- and case-independent", () => {
  const a = allowlistRoot(["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"])
  const b = allowlistRoot(["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"])
  assert.ok(!("error" in a) && !("error" in b))
  if (!("error" in a) && !("error" in b)) assert.equal(a.root, b.root)
})
