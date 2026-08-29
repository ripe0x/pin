import assert from "node:assert/strict"
import test from "node:test"
import { privateKeyToAccount } from "viem/accounts"
import { verifyMessage } from "viem"
import {
  buildArtistRefreshMessage,
  buildTokenRefreshMessage,
  isFreshRefreshNonce,
} from "./refresh-auth"

const account = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)

test("artist refresh proof binds the lowercase artist and nonce", async () => {
  const nonce = 1_787_900_000
  const message = buildArtistRefreshMessage(account.address.toUpperCase(), nonce)
  const signature = await account.signMessage({ message })

  assert.equal(message, `PND artist refresh v1\nartist=${account.address.toLowerCase()}\nnonce=${nonce}`)
  assert.equal(await verifyMessage({ address: account.address, message, signature }), true)
  assert.equal(
    await verifyMessage({
      address: account.address,
      message: buildArtistRefreshMessage(account.address, nonce + 1),
      signature,
    }),
    false,
  )
})

test("artist refresh nonce accepts one minute of future skew and expires at five minutes", () => {
  const now = 10_000
  assert.equal(isFreshRefreshNonce(now, now), true)
  assert.equal(isFreshRefreshNonce(now + 60, now), true)
  assert.equal(isFreshRefreshNonce(now + 61, now), false)
  assert.equal(isFreshRefreshNonce(now - 300, now), true)
  assert.equal(isFreshRefreshNonce(now - 301, now), false)
  assert.equal(isFreshRefreshNonce(Number.NaN, now), false)
})

test("token refresh proof binds the signer and exact token", async () => {
  const nonce = 1_787_900_000
  const contract = "0xdef0000000000000000000000000000000000000"
  const message = buildTokenRefreshMessage(account.address, contract, "42", nonce)
  const signature = await account.signMessage({ message })

  assert.equal(
    message,
    `PND token metadata refresh v1\nsigner=${account.address.toLowerCase()}\ncontract=${contract}\ntokenId=42\nnonce=${nonce}`,
  )
  assert.equal(await verifyMessage({ address: account.address, message, signature }), true)
  assert.equal(
    await verifyMessage({
      address: account.address,
      message: buildTokenRefreshMessage(account.address, contract, "43", nonce),
      signature,
    }),
    false,
  )
})
