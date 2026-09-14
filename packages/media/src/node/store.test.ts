import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  buildSignedPutRequest,
  fileStore,
  s3ConfigFromEnv,
  type S3StoreConfig,
} from "./store.ts"
import { derivativeKey } from "../derivative.ts"

const config: S3StoreConfig = {
  endpoint: new URL("https://example.r2.cloudflarestorage.com"),
  bucket: "pnd-media",
  publicBaseUrl: "https://media.example.test",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  region: "auto",
  prefix: "media-cache/v1",
}

test("derivativeKey object keys are content-addressed and path-safe", () => {
  const hash = "a".repeat(64)
  assert.equal(derivativeKey(config.prefix, hash, ".webp"), `media-cache/v1/aa/${hash}.webp`)
})

test("signed PUT request is deterministic and signs content type", () => {
  const request = buildSignedPutRequest(
    config,
    "media-cache/v1/aa/file name.webp",
    Buffer.from("image"),
    "image/webp",
    new Date("2026-08-29T12:34:56.000Z"),
  )
  assert.equal(
    request.url,
    "https://example.r2.cloudflarestorage.com/pnd-media/media-cache/v1/aa/file%20name.webp",
  )
  assert.equal(request.headers["x-amz-date"], "20260829T123456Z")
  assert.match(request.headers.authorization, /Credential=test-key\/20260829\/auto\/s3\/aws4_request/)
  assert.match(
    request.headers.authorization,
    /SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date/,
  )
  assert.equal(request.headers["cache-control"], "public, max-age=31536000, immutable")
})

test("partial storage configuration fails closed", () => {
  assert.throws(() => s3ConfigFromEnv({ MEDIA_OBJECT_BUCKET: "only-one" }), /must be set together/)
  assert.equal(s3ConfigFromEnv({}), null)
})

test("public delivery URL must be HTTPS", () => {
  assert.throws(
    () =>
      s3ConfigFromEnv({
        MEDIA_OBJECT_ENDPOINT: "https://objects.example.test",
        MEDIA_OBJECT_BUCKET: "media",
        MEDIA_OBJECT_PUBLIC_BASE_URL: "http://media.example.test",
        MEDIA_OBJECT_ACCESS_KEY_ID: "key",
        MEDIA_OBJECT_SECRET_ACCESS_KEY: "secret",
      }),
    /PUBLIC_BASE_URL must use https/,
  )
})

test("fileStore writes bytes under dir and returns a publicBase URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pnd-media-store-"))
  try {
    const store = fileStore({ dir, publicBase: "https://artist.example/media" })
    const key = derivativeKey("media", "b".repeat(64), "webp")
    const { url } = await store.put(key, Buffer.from("hello"), "image/webp")
    assert.equal(url, `https://artist.example/media/${key}`)
    const written = await readFile(join(dir, key))
    assert.equal(written.toString(), "hello")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
