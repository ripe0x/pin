import assert from "node:assert/strict"
import { test } from "node:test"
import { chooseDisplayMedia } from "./display-media"

const ref = { contract: "0xabc", tokenId: "1" }

function readyDelivery(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready" as const,
    kind: "image" as const,
    originalUrl: "ipfs://source",
    resolvedUrl: null,
    thumbnailUrl: "https://media.example/thumb.webp",
    posterUrl: null,
    width: 800,
    height: 600,
    mimeType: "image/jpeg",
    sourceBytes: 1000,
    derivativeBytes: 100,
    sha256: null,
    attempts: 1,
    lastError: null,
    nextAttemptAt: null,
    ...overrides,
  }
}

test("a ready image delivery wins over raw metadata", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "ipfs://source", animationUrl: null },
    readyDelivery(),
    ref,
  )
  assert.deepEqual(media, {
    kind: "image",
    src: "https://media.example/thumb.webp",
    width: 800,
    height: 600,
  })
})

test("a ready video delivery returns its poster and resolved source", () => {
  const media = chooseDisplayMedia(
    { imageUrl: null, animationUrl: "ipfs://clip" },
    readyDelivery({
      kind: "video",
      thumbnailUrl: null,
      posterUrl: "https://media.example/poster.webp",
      resolvedUrl: "https://dweb.link/ipfs/clip",
    }),
    ref,
  )
  assert.deepEqual(media, {
    kind: "video",
    src: "https://dweb.link/ipfs/clip",
    poster: "https://media.example/poster.webp",
    width: 800,
    height: 600,
  })
})

test("a pending or failed delivery falls through to metadata", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "https://cdn.example/art.png", animationUrl: null },
    readyDelivery({ status: "pending" }),
    ref,
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
    readyDelivery({ status: "pending", kind: "video", thumbnailUrl: null }),
    ref,
  )
  assert.deepEqual(media, {
    kind: "video",
    src: "https://nft-cdn.example/eth-mainnet/0e2f9b0b",
    poster: null,
    width: null,
    height: null,
  })
})

test("an inline image data URI routes through the token media API", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "data:image/svg+xml;base64,AAAA", animationUrl: null },
    null,
    ref,
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
  )
  assert.deepEqual(media, { kind: "none" })
})

test("ipfs:// metadata resolves to a gateway URL", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "ipfs://bafy-image", animationUrl: null },
    null,
    ref,
  )
  assert.equal(media.kind, "image")
  assert.equal((media as { src: string }).src, "https://dweb.link/ipfs/bafy-image")
})

test("a remote video URL is classified by extension", () => {
  const media = chooseDisplayMedia(
    { imageUrl: "https://cdn.example/work.webm", animationUrl: null },
    null,
    ref,
  )
  assert.deepEqual(media, {
    kind: "video",
    src: "https://cdn.example/work.webm",
    poster: null,
    width: null,
    height: null,
  })
})

test("no metadata and no delivery yields none", () => {
  assert.deepEqual(
    chooseDisplayMedia({ imageUrl: null, animationUrl: null }, null, ref),
    { kind: "none" },
  )
  assert.deepEqual(chooseDisplayMedia(null, null, ref), { kind: "none" })
})
