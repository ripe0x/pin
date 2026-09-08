import assert from "node:assert/strict"
import test from "node:test"
import {
  buildSignedPutRequest,
  mediaObjectStorageFromEnv,
  objectKeyFor,
  type MediaObjectStorage,
} from "./object-storage.ts"

const storage: MediaObjectStorage = {
  endpoint: new URL("https://example.r2.cloudflarestorage.com"),
  bucket: "pnd-media",
  publicBaseUrl: "https://media.example.test",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  region: "auto",
  prefix: "media-cache/v1",
}

test("object keys are content-addressed and path-safe", () => {
  const hash = "a".repeat(64)
  assert.equal(
    objectKeyFor(storage, hash, ".webp"),
    `media-cache/v1/aa/${hash}.webp`,
  )
})

test("signed PUT request is deterministic and signs content type", () => {
  const request = buildSignedPutRequest(
    storage,
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
  assert.equal(
    request.headers["cache-control"],
    "public, max-age=31536000, immutable",
  )
})

test("partial storage configuration fails closed", () => {
  assert.throws(
    () => mediaObjectStorageFromEnv({ MEDIA_OBJECT_BUCKET: "only-one" }),
    /must be set together/,
  )
  assert.equal(mediaObjectStorageFromEnv({}), null)
})

test("public delivery URL must be HTTPS", () => {
  assert.throws(
    () =>
      mediaObjectStorageFromEnv({
        MEDIA_OBJECT_ENDPOINT: "https://objects.example.test",
        MEDIA_OBJECT_BUCKET: "media",
        MEDIA_OBJECT_PUBLIC_BASE_URL: "http://media.example.test",
        MEDIA_OBJECT_ACCESS_KEY_ID: "key",
        MEDIA_OBJECT_SECRET_ACCESS_KEY: "secret",
      }),
    /PUBLIC_BASE_URL must use https/,
  )
})
