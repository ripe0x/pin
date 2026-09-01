import assert from "node:assert/strict"
import test from "node:test"
import { encodeEventTopics, parseAbi, pad, toHex } from "viem"
import {
  IdMode,
  SurfaceStatus,
  extractRevealTokenId,
  formatWriteError,
  isMintable,
  lifecycleStatus,
  quoteFixedPrice,
  prepareFixedPriceMint,
  referralAmount,
  resolvePhaseState,
  sellsViaMinterOnly,
  type RevealLog,
} from "./index.ts"

const openWindow = { mintStart: 100n, mintEnd: 200n, supplyCap: 10n }

test("lifecycle and mintability share one boundary implementation", () => {
  assert.equal(lifecycleStatus(openWindow, 0n, 99), SurfaceStatus.Scheduled)
  assert.equal(lifecycleStatus(openWindow, 0n, 100), SurfaceStatus.Open)
  assert.equal(lifecycleStatus(openWindow, 0n, 200), SurfaceStatus.Closed)
  assert.equal(lifecycleStatus(openWindow, 10n, 150), SurfaceStatus.Closed)
  assert.equal(isMintable(openWindow, 9n, 150), true)
  assert.equal(isMintable(openWindow, 10n, 150), false)
  assert.equal(sellsViaMinterOnly(IdMode.Pooled), true)
})

test("fixed quotes and referral amounts stay integer and bounded", () => {
  assert.equal(quoteFixedPrice(100n, 3n), 300n)
  assert.equal(referralAmount(333n, 1000), 33n)
  assert.throws(() => quoteFixedPrice(100n, 0n), /at least one/)
  assert.throws(() => referralAmount(100n, 10_001), /between 0 and 10000/)
})

test("fixed-price transaction preparation is identical across consumers", () => {
  const request = prepareFixedPriceMint({
    chainId: 1,
    minter: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    referrer: "0x3333333333333333333333333333333333333333",
    quantity: 2n,
    totalValue: 20n,
  })
  assert.equal(request.target, "0x1111111111111111111111111111111111111111")
  assert.equal(request.functionName, "mint")
  assert.deepEqual(request.args, [
    "0x2222222222222222222222222222222222222222",
    2n,
    "0x3333333333333333333333333333333333333333",
    "0x",
  ])
  assert.equal(request.value, 20n)
})

test("phase boundaries select the later phase at an exact handoff", () => {
  const windows = [
    { key: "allowlist", label: "Allowlist", start: "100", end: "200" },
    { key: "public", label: "Public", start: "200", end: "0" },
  ]
  assert.equal(resolvePhaseState(windows, 199).activeKey, "allowlist")
  assert.equal(resolvePhaseState(windows, 200).activeKey, "public")
})

test("protocol errors retain shared recovery copy", () => {
  const error = { shortMessage: "reverted", cause: { data: { errorName: "WrongPayment" } } }
  assert.equal(
    formatWriteError(error, "Mint"),
    "The price changed since the page loaded. The quote has been refreshed, try again.",
  )
  assert.equal(formatWriteError({ message: "User rejected the request" }, "Mint"), "Transaction rejected")
})

test("reveal extracts an ERC-721 mint without another RPC read", () => {
  const collection = "0x1111111111111111111111111111111111111111"
  const recipient = "0x2222222222222222222222222222222222222222"
  const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"])
  const topics = encodeEventTopics({
    abi,
    eventName: "Transfer",
    args: {
      from: "0x0000000000000000000000000000000000000000",
      to: recipient,
      tokenId: 42n,
    },
  })
  const log: RevealLog = {
    address: collection,
    topics: topics as readonly `0x${string}`[],
    data: pad(toHex(0n)),
  }
  assert.equal(extractRevealTokenId({ reveal: { kind: "transfer-log" }, logs: [log], collection, abi }), 42n)
})
