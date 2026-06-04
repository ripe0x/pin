/**
 * Run with:
 *   node --experimental-strip-types --test \
 *     apps/web/src/lib/muri/build-init-config.test.ts
 *
 * Verifies the MURI InitConfig builder against the real extension ABI:
 * viem's encodeFunctionData validates the (deeply nested) tuple shape, so
 * if a struct field is misnamed or mistyped the encode throws and the test
 * fails — before any wallet ever signs a mint. Also pins the metadata-body
 * wrapping (no outer braces — renderMetadata adds them) and the default
 * permission flags.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { encodeFunctionData } from "viem"
import { muriProtocolManifoldExtensionAbi } from "@pin/abi"
import {
  buildInitConfig,
  buildMetadataBody,
  DISPLAY_MODE,
} from "./build-init-config.ts"
import { buildPermissionFlags, ARTIST_ALL, MURI_PERM } from "./permissions.ts"

const CONTRACT = "0x435BD9CF72C278c9bAD9655732a6724469c6D9Ff" as const
const RECIPIENT = "0x0000000000000000000000000000000000000006" as const

const sampleConfig = () =>
  buildInitConfig({
    name: "Test Piece",
    description: 'A "quoted" desc, with comma',
    attributes: [{ trait_type: "Medium", value: "webp" }],
    artworkUris: [
      "https://nftstorage.link/ipfs/bafyTEST",
      "https://dweb.link/ipfs/bafyTEST",
    ],
    mimeType: "image/webp",
    fileHash: "0xe8aedbf3bc73d04190e7efe63c2c55af070960790b4979d14bac0ba6a73dfe94",
  })

test("metadata body has no outer braces and escapes correctly", () => {
  const body = buildMetadataBody("Test", 'has "quotes"', [
    { trait_type: "X", value: 1 },
  ])
  assert.ok(!body.startsWith("{"), "must not start with brace")
  assert.ok(!body.endsWith("}"), "must not end with brace")
  // Wrapping in braces must yield valid JSON (what renderMetadata does).
  const parsed = JSON.parse(`{${body}}`)
  assert.equal(parsed.name, "Test")
  assert.equal(parsed.description, 'has "quotes"')
  assert.deepEqual(parsed.attributes, [{ trait_type: "X", value: 1 }])
})

test("default permission flags: full artist + collector add/choose", () => {
  const flags = buildPermissionFlags()
  assert.equal(
    flags,
    ARTIST_ALL | MURI_PERM.COLLECTOR_ADD_REMOVE | MURI_PERM.COLLECTOR_CHOOSE_URIS,
  )
  assert.equal(flags, 511) // 0x7F | 0x100 | 0x80
  // Opting collectors out leaves only the 7 artist bits.
  assert.equal(buildPermissionFlags({ allowCollectorFallbacks: false }), 127)
})

test("buildInitConfig produces the off-chain v1 shape", () => {
  const c = sampleConfig()
  assert.equal(c.artwork.artistUris.length, 2)
  assert.deepEqual(c.artwork.collectorUris, [])
  assert.equal(c.thumbnail.kind, 1) // OFF_CHAIN
  assert.deepEqual(c.thumbnail.offChain.uris, c.artwork.artistUris) // defaults to artwork
  assert.equal(c.displayMode, DISPLAY_MODE.HTML)
  assert.deepEqual(c.htmlTemplate.chunks, [])
  assert.equal(c.artwork.selectedArtistUriIndex, 0n)
})

test("InitConfig encodes against mintERC721 ABI (validates tuple shape)", () => {
  const data = encodeFunctionData({
    abi: muriProtocolManifoldExtensionAbi,
    functionName: "mintERC721",
    args: [CONTRACT, RECIPIENT, sampleConfig(), [], []],
  })
  assert.ok(data.startsWith("0x"))
  assert.ok(data.length > 10)
})

test("InitConfig encodes against mintERC1155 ABI (validates tuple shape)", () => {
  const data = encodeFunctionData({
    abi: muriProtocolManifoldExtensionAbi,
    functionName: "mintERC1155",
    args: [CONTRACT, [RECIPIENT], [3n], sampleConfig(), [], []],
  })
  assert.ok(data.startsWith("0x"))
})
