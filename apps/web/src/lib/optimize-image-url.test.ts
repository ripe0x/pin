import { strict as assert } from "node:assert"
import { test } from "node:test"
import { optimizeImageUrl } from "./optimize-image-url.ts"

test("proxies slow TBAM renderer images", () => {
  const result = optimizeImageUrl(
    "https://tbam-api.fly.dev/api/token/edition/3300",
    800,
  )
  assert.match(result, /^https:\/\/images\.weserv\.nl\//)
  assert.match(result, /tbam-api\.fly\.dev/)
})

test("does not proxy lookalike host suffixes", () => {
  const source = "https://evilnftstorage.link/image.png"
  assert.equal(optimizeImageUrl(source, 800), source)
})

test("still proxies subdomains of approved gateways", () => {
  const source = "https://bafy.example.ipfs.dweb.link/image.png"
  assert.match(optimizeImageUrl(source, 800), /^https:\/\/images\.weserv\.nl\//)
})
