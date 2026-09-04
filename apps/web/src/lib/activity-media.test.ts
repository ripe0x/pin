import assert from "node:assert/strict"
import test from "node:test"
import { mediaForActivityFeed } from "./activity-media"

test("activity feed replaces inline media with a compact route", () => {
  assert.deepEqual(
    mediaForActivityFeed(
      "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==",
      "/api/media/token/0xabc/1",
    ),
    { mediaUrl: "/api/media/token/0xabc/1", isVideo: false },
  )
})

test("activity feed never serializes inline media without a safe route", () => {
  assert.deepEqual(mediaForActivityFeed("  DATA:image/svg+xml,%3Csvg/%3E  "), {
    mediaUrl: null,
    isVideo: false,
  })
})

test("activity feed keeps remote images and identifies remote video", () => {
  assert.deepEqual(mediaForActivityFeed("ipfs://bafy-image"), {
    mediaUrl: "https://nftstorage.link/ipfs/bafy-image",
    isVideo: false,
  })
  assert.deepEqual(mediaForActivityFeed("https://cdn.example/work.webm?x=1"), {
    mediaUrl: "https://cdn.example/work.webm?x=1",
    isVideo: true,
  })
})
