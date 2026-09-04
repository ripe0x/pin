import assert from "node:assert/strict"
import test from "node:test"
import { privateKeyToAccount } from "viem/accounts"
import {
  artistSiteTypedData,
  canonicalReleaseManifest,
  negotiateCapabilities,
  normalizeArtistSiteDeclaration,
  normalizeReleaseManifest,
  parseReleaseManifestJson,
  releaseManifestDigest,
  releaseManifestTypedData,
  verifyArtistSiteDeclaration,
  verifyReleaseManifestAuthorship,
  type ArtistSiteDeclarationV1,
  type ReleaseManifestV1,
} from "./index.ts"

const privateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const
const account = privateKeyToAccount(privateKey)
const collection = "0x1111111111111111111111111111111111111111" as const

function unsignedFixture(): ReleaseManifestV1 {
  return {
    spec: "pnd.release",
    version: 1,
    release: {
      id: `pnd:1:${collection}:c`,
      chain: { namespace: "eip155", reference: "1" },
      collection,
      protocol: { family: "surface", abi: "surface@1" },
    },
    declaration: {
      artist: account.address,
      title: "A portable release",
      announcedSchedule: { opensAt: "2026-08-31T12:00:00Z" },
    },
    capabilities: {
      required: ["surface.mint@1", "surface.state@1", "surface.mint@1"],
      optional: ["history.mints@1"],
      adapters: [
        { capability: "surface.mint@1", adapter: "surface.fixed-price@1", target: "primary-minter" },
      ],
    },
  }
}

test("normalization lowercases addresses and deterministically sorts capabilities", () => {
  const fixture = unsignedFixture()
  fixture.release.collection = collection.toUpperCase().replace("0X", "0x") as `0x${string}`
  fixture.release.id = fixture.release.id.toUpperCase()
  const normalized = normalizeReleaseManifest(fixture)
  assert.equal(normalized.release.collection, collection)
  assert.equal(normalized.release.id, `pnd:1:${collection}:c`)
  assert.deepEqual(normalized.capabilities.required, ["surface.mint@1", "surface.state@1"])
  assert.equal(canonicalReleaseManifest(normalized), canonicalReleaseManifest(normalizeReleaseManifest(JSON.parse(JSON.stringify(fixture)))))
})

test("strict JSON parsing rejects duplicate keys before normalization", () => {
  const json = JSON.stringify(unsignedFixture()).replace('"spec":"pnd.release"', '"spec":"pnd.release","spec":"pnd.release"')
  assert.throws(() => parseReleaseManifestJson(json), /duplicate object key/)
})

test("unknown keys and mismatched release ids fail closed", () => {
  assert.throws(() => normalizeReleaseManifest({ ...unsignedFixture(), currentPrice: "1" }), /unknown key/)
  const fixture = unsignedFixture()
  fixture.release.id = `pnd:1:0x2222222222222222222222222222222222222222:c`
  assert.throws(() => normalizeReleaseManifest(fixture), /expected "pnd:1:/)
})

test("manifest digest and EIP-712 authorship verify against normalized content", async () => {
  const unsigned = normalizeReleaseManifest(unsignedFixture())
  const digest = releaseManifestDigest(unsigned)
  const issuedAt = "2026-08-31T12:30:00.000Z"
  const draft = normalizeReleaseManifest({
    ...unsigned,
    authorship: {
      scheme: "eip712",
      signer: account.address,
      issuedAt,
      digest,
      signature: `0x${"00".repeat(65)}`,
    },
  })
  const signature = await account.signTypedData(releaseManifestTypedData(draft))
  const signed = normalizeReleaseManifest({ ...draft, authorship: { ...draft.authorship!, signature } })
  assert.equal(await verifyReleaseManifestAuthorship(signed), true)
  const tampered = { ...signed, declaration: { ...signed.declaration, title: "Changed" } }
  assert.throws(() => normalizeReleaseManifest(tampered), /digest does not match/)
})

test("capability negotiation disables unknown required behavior but not optional context", () => {
  const manifest = normalizeReleaseManifest(unsignedFixture())
  const negotiated = negotiateCapabilities(manifest, {
    intrinsic: ["surface.state@1"],
    adapters: ["surface.fixed-price@1"],
  })
  assert.equal(negotiated.compatible, true)
  assert.equal(negotiated.states["history.mints@1"]?.status, "unsupported")
  const missingAdapter = negotiateCapabilities(manifest, { intrinsic: ["surface.state@1"] })
  assert.equal(missingAdapter.compatible, false)
  assert.equal(missingAdapter.states["surface.mint@1"]?.status, "incompatible")
})

test("artist site declarations are normalized and verifiable without claiming domain control", async () => {
  const draft = normalizeArtistSiteDeclaration({
    spec: "pnd.artist-site",
    version: 1,
    chain: { namespace: "eip155", reference: "1" },
    artist: account.address,
    url: "https://artist.example/releases",
    collections: [collection, collection.toUpperCase().replace("0X", "0x")],
    kit: { name: "@pin/surface-react", version: "1.0.0" },
    issuedAt: "2026-08-31T12:30:00Z",
    expiresAt: "2027-08-31T12:30:00Z",
    nonce: `0x${"12".repeat(32)}`,
    signature: `0x${"00".repeat(65)}`,
  })
  const signature = await account.signTypedData(artistSiteTypedData(draft))
  const signed: ArtistSiteDeclarationV1 = { ...draft, signature }
  assert.deepEqual(signed.collections, [collection])
  assert.equal(await verifyArtistSiteDeclaration(signed), true)
  assert.equal(await verifyArtistSiteDeclaration({ ...signed, url: "https://other.example" }), false)
})
