import { strict as assert } from "node:assert"
import { test } from "node:test"
import { isAllowedGatewayUrl, liveRedirectTarget } from "./live-redirect.ts"

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
const AR = "HEYlwpGS0v40F7Jr_QQa-lXIy0oYJP2i8GYvn5leSH8"

test("ipfs:// and gateway-embedded CIDs go to the fixed IPFS gateway", () => {
  assert.equal(liveRedirectTarget(`ipfs://${CID}/index.html`), `https://ipfs.io/ipfs/${CID}/index.html`)
  assert.equal(
    liveRedirectTarget(`https://some-pinning.example/ipfs/${CID}`),
    `https://ipfs.io/ipfs/${CID}`,
  )
})

test("ar:// and Arweave gateway URLs are allowed", () => {
  assert.equal(liveRedirectTarget(`ar://${AR}`), `https://arweave.net/${AR}`)
  assert.equal(liveRedirectTarget(`https://arweave.net/${AR}/index.html`), `https://arweave.net/${AR}/index.html`)
  assert.equal(
    liveRedirectTarget(`https://abcdefgh.arweave.net/${AR}`),
    `https://abcdefgh.arweave.net/${AR}`,
  )
})

test("arbitrary hosts are not redirect targets", () => {
  assert.equal(liveRedirectTarget("https://evil.example/phish"), null)
  assert.equal(liveRedirectTarget("https://arweave.net.evil.example/x"), null)
  assert.equal(liveRedirectTarget("http://ipfs.io/ipfs/x"), null)
  assert.equal(liveRedirectTarget("javascript:alert(1)"), null)
  assert.equal(liveRedirectTarget("//evil.example/x"), null)
  assert.equal(liveRedirectTarget("https://user:pw@ipfs.io/x"), null)
  assert.equal(liveRedirectTarget(""), null)
})

test("gateway allowlist covers the shared gateway lists", () => {
  assert.equal(isAllowedGatewayUrl("https://dweb.link/ipfs/x"), true)
  assert.equal(isAllowedGatewayUrl(`https://${CID}.ipfs.dweb.link/`), true)
  assert.equal(isAllowedGatewayUrl("https://gateway.pinata.cloud/ipfs/x"), true)
  assert.equal(isAllowedGatewayUrl("https://ipfs.io:8443/ipfs/x"), false)
})
