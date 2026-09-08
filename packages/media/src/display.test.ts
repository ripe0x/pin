import assert from "node:assert/strict"
import { test } from "node:test"
import { chooseDisplayMedia } from "./display.ts"
import type { MediaRecord } from "./record.ts"

const ref = { contract: "0xabc", tokenId: "1" }
const opts = { inlineUrl: (r: typeof ref) => `/api/media/token/${r.contract}/${r.tokenId}` }

function readyRecord(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    contract: "0xabc",
    tokenId: "1",
    sourceUrl: "ipfs://source",
    resolvedUrl: null,
    kind: "image",
    status: "ready",
    thumbnailUrl: "https://media.example/thumb.webp",
    posterUrl: null,
    width: 800,
    height: 600,
    durationMs: null,
    mimeType: "image/jpeg",
    sourceBytes: 1000,
    derivativeBytes: 100,
    sourceSha256: null,
    derivativeSha256: null,
    preferredGateway: null,
    attemptCount: 1,
    lastError: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    ...overrides,
  }
}

test("a ready image record wins over raw metadata", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "ipfs://source", animationUrl: null },
    readyRecord(),
    ref,
    opts,
  )
  assert.deepEqual(media, {
    kind: "image",
    src: "https://media.example/thumb.webp",
    width: 800,
    height: 600,
  })
})

test("a ready video record returns its poster and resolved source", () => {
  const media = chooseDisplayMedia(
    { imageUrl: null, animationUrl: "ipfs://clip" },
    readyRecord({
      kind: "video",
      thumbnailUrl: null,
      posterUrl: "https://media.example/poster.webp",
      resolvedUrl: "https://dweb.link/ipfs/clip",
    }),
    ref,
    opts,
  )
  assert.deepEqual(media, {
    kind: "video",
    src: "https://dweb.link/ipfs/clip",
    poster: "https://media.example/poster.webp",
    width: 800,
    height: 600,
  })
})

test("a pending or failed record falls through to metadata", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "https://cdn.example/art.png", animationUrl: null },
    readyRecord({ status: "pending" }),
    ref,
    opts,
  )
  assert.deepEqual(media, {
    kind: "image",
    src: "https://cdn.example/art.png",
    width: null,
    height: null,
  })
})

test("a probed video kind settles an extension-less URL as video before a poster exists", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "https://nft-cdn.example/eth-mainnet/0e2f9b0b", animationUrl: null },
    readyRecord({ status: "pending", kind: "video", thumbnailUrl: null, posterUrl: null }),
    ref,
    opts,
  )
  assert.deepEqual(media, {
    kind: "video",
    src: "https://nft-cdn.example/eth-mainnet/0e2f9b0b",
    poster: null,
    width: null,
    height: null,
  })
})

test("an inline image data URI routes through the caller's inline URL", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "data:image/svg+xml;base64,AAAA", animationUrl: null },
    null,
    ref,
    opts,
  )
  assert.deepEqual(media, {
    kind: "image",
    src: "/api/media/token/0xabc/1",
    width: null,
    height: null,
  })
})

test("an inline HTML animation is not displayable, so it is dropped", () => {
  const media = chooseDisplayMedia(
    { imageUrl: null, animationUrl: "data:text/html;base64,AAAA" },
    null,
    ref,
    opts,
  )
  assert.deepEqual(media, { kind: "none" })
})

test("ipfs:// metadata resolves to a gateway URL", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "ipfs://bafy-image", animationUrl: null },
    null,
    ref,
    opts,
  )
  assert.equal(media.kind, "image")
  assert.equal((media as { src: string }).src, "https://dweb.link/ipfs/bafy-image")
})

test("a remote video URL is classified by extension", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "https://cdn.example/work.webm", animationUrl: null },
    null,
    ref,
    opts,
  )
  assert.deepEqual(media, {
    kind: "video",
    src: "https://cdn.example/work.webm",
    poster: null,
    width: null,
    height: null,
  })
})

test("no metadata and no record yields none", () => {
  assert.deepEqual(
    chooseDisplayMedia({ imageUrl: null, animationUrl: null }, null, ref, opts),
    { kind: "none" },
  )
  assert.deepEqual(chooseDisplayMedia(null, null, ref, opts), { kind: "none" })
})
