/**
 * Tests the shared writeback message-builder + the verifyMessage
 * boundary it feeds. We don't import the route handler directly
 * (it relies on next/server), but we exercise the same primitives
 * — signMessage / verifyMessage from viem — to prove a real signed
 * payload verifies and the obvious tamper / stale-nonce cases reject.
 *
 * Run: node --experimental-strip-types --test apps/web/src/lib/preserve-writeback.test.ts
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { verifyMessage } from "viem"
import {
  buildWritebackMessage,
  isFreshNonce,
  isValidProvider,
} from "./preserve-writeback.ts"

const FIXED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const

test("buildWritebackMessage is deterministic across cid order", () => {
  const a = buildWritebackMessage({
    artist: "0xABCDEF0123456789abcdef0123456789ABCDEF01",
    cids: ["QmA", "QmZ", "QmM"],
    provider: "pinata",
    nonce: 1_700_000_000,
  })
  const b = buildWritebackMessage({
    artist: "0xabcdef0123456789abcdef0123456789abcdef01",
    cids: ["QmZ", "QmM", "QmA"],
    provider: "pinata",
    nonce: 1_700_000_000,
  })
  assert.equal(a, b, "case + insertion-order differences should not change the message")
  // And spot-check shape:
  assert.match(a, /^PND preserve writeback v1\n/)
  assert.match(a, /\nartist=0xabcdef0123456789abcdef0123456789abcdef01\n/)
  assert.match(a, /\ncids=QmA,QmM,QmZ\n/)
  assert.match(a, /\nprovider=pinata\n/)
  assert.match(a, /\nnonce=1700000000$/)
})

test("verifyMessage accepts a real signature over the canonical message", async () => {
  const account = privateKeyToAccount(FIXED_PK)
  const nonce = Math.floor(Date.now() / 1000)
  const cids = ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"]
  const message = buildWritebackMessage({
    artist: account.address,
    cids,
    provider: "4everland",
    nonce,
  })
  const signature = await account.signMessage({ message })
  const ok = await verifyMessage({
    address: account.address,
    message,
    signature,
  })
  assert.equal(ok, true)
})

test("verifyMessage rejects a tampered message", async () => {
  const account = privateKeyToAccount(FIXED_PK)
  const nonce = Math.floor(Date.now() / 1000)
  const cids = ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"]
  const signed = buildWritebackMessage({
    artist: account.address,
    cids,
    provider: "4everland",
    nonce,
  })
  const signature = await account.signMessage({ message: signed })
  // Server tries to verify with a different CID set.
  const tampered = buildWritebackMessage({
    artist: account.address,
    cids: ["QmTampered"],
    provider: "4everland",
    nonce,
  })
  const ok = await verifyMessage({
    address: account.address,
    message: tampered,
    signature,
  })
  assert.equal(ok, false)
})

test("verifyMessage rejects a signature from a different address", async () => {
  const attacker = privateKeyToAccount(FIXED_PK)
  const claimedArtist = privateKeyToAccount(generatePrivateKey())
  const nonce = Math.floor(Date.now() / 1000)
  const message = buildWritebackMessage({
    artist: claimedArtist.address,
    cids: ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"],
    provider: "4everland",
    nonce,
  })
  // Attacker signs a message that claims to be from the artist.
  const signature = await attacker.signMessage({ message })
  const ok = await verifyMessage({
    address: claimedArtist.address,
    message,
    signature,
  })
  assert.equal(ok, false)
})

test("isFreshNonce accepts now and clock-skew slop, rejects past + far-future", () => {
  const now = 1_700_000_000
  assert.equal(isFreshNonce(now, now), true)
  assert.equal(isFreshNonce(now - 30 * 60, now), true, "30 min old → fresh")
  assert.equal(isFreshNonce(now - 61 * 60, now), false, "61 min old → stale")
  assert.equal(isFreshNonce(now + 60, now), true, "60s into future → ok (skew)")
  assert.equal(isFreshNonce(now + 10 * 60, now), false, "10 min into future → rejected")
  assert.equal(isFreshNonce(NaN, now), false)
})

test("isValidProvider recognises only the three known IDs", () => {
  assert.equal(isValidProvider("pinata"), true)
  assert.equal(isValidProvider("4everland"), true)
  assert.equal(isValidProvider("web3storage"), true)
  assert.equal(isValidProvider("ipfs.io"), false)
  assert.equal(isValidProvider(""), false)
})
