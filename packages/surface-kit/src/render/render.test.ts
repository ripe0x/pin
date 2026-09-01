import assert from "node:assert/strict"
import test from "node:test"
import { buildContextJs, buildTokenHTML } from "./build.ts"
import { memoryResolver } from "./resolve.ts"
import { CODE_KIND, type CodeRefLike } from "./types.ts"

const store = "0x1111111111111111111111111111111111111111" as const
const code: CodeRefLike = { store, name: "work.js", kind: CODE_KIND.Script }
const dependency: CodeRefLike = { store, name: "dep.js", kind: CODE_KIND.Script }
const gunzip = { store, name: "gunzip.js" }

test("token context remains byte-identical to the onchain injection convention", () => {
  assert.equal(
    buildContextJs({
      hash: "0xAB00000000000000000000000000000000000000000000000000000000000001",
      tokenId: "7",
      collection: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      chainId: 1,
      version: 1,
      context: "token",
    }),
    'window.tokenData={"hash":"0xab00000000000000000000000000000000000000000000000000000000000001","tokenId":"7","collection":"0xabcdef0123456789abcdef0123456789abcdef01","chainId":1,"version":1,"context":"token"};',
  )
})

test("document assembly preserves dependency, context, and code order", async () => {
  const html = await buildTokenHTML(
    { code: [code], deps: [dependency], injectionVersion: 1 },
    {
      hash: `0x${"12".repeat(32)}`,
      tokenId: "1",
      collection: store,
      chainId: 1,
      version: 1,
      context: "preview",
    },
    memoryResolver([[dependency, "dependency()"], [code, "artwork()"]]),
    { gunzip },
  )
  assert.ok(html.indexOf("dependency()") < html.indexOf("window.tokenData"))
  assert.ok(html.indexOf("window.tokenData") < html.indexOf("artwork()"))
  assert.ok(html.startsWith("<html><head><style>"))
})
