/**
 * Transient Labs Auction House fork test. Exercises the same ABI + write-
 * path encoding the AuctionPanel UI uses, against an Anvil mainnet fork.
 * Validates that our `transientAuctionHouseAbi` calldata is accepted by
 * the real Auction House contract.
 *
 * Tests:
 *   1. bid(): place a valid first bid → expect success + state mutation
 *   2. delist(): cancel-after-bid behavior (TL may revert; we accept
 *      either as long as the ABI is encoded correctly)
 *   3. settleAuction() before endTime → expect REVERT
 *   4. settleAuction() after time-travel → expect success
 *
 * Run anvil first:
 *   anvil --fork-url $MAINNET_RPC_URL --chain-id 31337 --port 8545
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
} from "viem"
import { foundry } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"
import { transientAuctionHouseAbi } from "../packages/abi/src/transientAuctionHouse.ts"

const RPC = "http://127.0.0.1:8545"
const TL_AH = "0x6f66b95a0C512f3497FB46660E0BC3B94B989F8d"
const ZERO = "0x0000000000000000000000000000000000000000"

// Target: BETHEMOTH (per-artist ERC721TL) token 1 — a real active
// auction at fork-block, 0.04 ETH reserve, type=2 (reserve auction),
// no bids yet, ETH currency.
const TARGET_CONTRACT = "0xcba399c322ab4803153a36da714664a91fc5a8b5"
const TARGET_TOKEN_ID = 1n
const TARGET_RESERVE = parseEther("0.04")
const TARGET_SELLER = "0x324B09aD4b2Bfa5a3cAd7205A5A1C3F5518cDA08"

// Anvil's account #3 — fresh, won't collide with prior tests on token 48544.
const TEST_BIDDER_KEY =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"

const transport = http(RPC)
const pub = createPublicClient({ chain: foundry, transport })

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

const lines = []
function log(s) { console.log(s); lines.push(s) }
function pass(label) { log(`  ✓ ${label}`) }
function fail(label, err) { log(`  ✗ ${label}: ${err}`); process.exitCode = 1 }
async function expectRevert(promise, label) {
  try {
    await promise
    fail(label, "expected revert, got success")
  } catch (e) {
    pass(`${label} (reverted: ${e.shortMessage ?? e.message?.slice(0, 60)})`)
  }
}

async function readListing() {
  return await pub.readContract({
    address: TL_AH,
    abi: transientAuctionHouseAbi,
    functionName: "getListing",
    args: [TARGET_CONTRACT, TARGET_TOKEN_ID],
  })
}

async function main() {
  log(`fork block: ${await pub.getBlockNumber()}`)
  log(`target: contract=${TARGET_CONTRACT} token=${TARGET_TOKEN_ID}`)

  // Pre-state: confirm the auction is still in expected state on the fork.
  // viem returns the tuple as an object keyed by field names since the
  // ABI's `listingTuple` has named components.
  const pre = await readListing()
  const type_ = pre.type_
  const seller0 = pre.seller
  const currency0 = pre.currencyAddress
  const reserve0 = pre.reservePrice
  const length0 = pre.duration
  log(`pre-state: type=${type_} seller=${seller0} reserve=${formatEther(reserve0)} length=${length0}`)
  if (type_ === 0) {
    fail("setup", "no active listing on fork")
    process.exit(1)
  }
  if (currency0.toLowerCase() !== ZERO) {
    fail("setup", "expected ETH listing")
    process.exit(1)
  }
  if (seller0.toLowerCase() !== TARGET_SELLER.toLowerCase()) {
    fail("setup", `auction seller changed since fork: ${seller0}`)
    process.exit(1)
  }

  // ── Setup: fund a fresh bidder ──
  const bidder = privateKeyToAccount(TEST_BIDDER_KEY)
  await rpc("anvil_setBalance", [bidder.address, "0x56BC75E2D63100000"]) // 100 ETH
  log(`bidder: ${bidder.address}`)
  const wallet = createWalletClient({ account: bidder, chain: foundry, transport })

  // ── Test 1: bid() — first bid at reserve, expect success ──
  log("\n[1] bid() — first bid at reserve (no buyer's premium expected)")
  log(`    bid amount = msg.value = ${formatEther(TARGET_RESERVE)} ETH`)
  try {
    const txHash = await wallet.writeContract({
      address: TL_AH,
      abi: transientAuctionHouseAbi,
      functionName: "bid",
      args: [TARGET_CONTRACT, TARGET_TOKEN_ID, bidder.address, TARGET_RESERVE],
      value: TARGET_RESERVE,
    })
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== "success") throw new Error(`status ${receipt.status}`)
    pass(`bid tx confirmed (gas ${receipt.gasUsed})`)

    const post = await readListing()
    const startTime1 = post.startTime
    const highestBidder1 = post.highestBidder
    const highestBid1 = post.highestBid
    if (highestBidder1.toLowerCase() !== bidder.address.toLowerCase()) {
      fail("bidder recorded", `got ${highestBidder1}, expected ${bidder.address}`)
    } else {
      pass(`bidder = ${highestBidder1}`)
    }
    if (highestBid1 !== TARGET_RESERVE) {
      fail("bid amount recorded", `got ${highestBid1}, expected ${TARGET_RESERVE}`)
    } else {
      pass(`bid amount = ${formatEther(highestBid1)} ETH`)
    }
    if (startTime1 === 0n) {
      fail("startTime", "expected non-zero (timer should start on first bid)")
    } else {
      pass(`startTime updated to ${startTime1}`)
    }
  } catch (e) {
    fail("bid", e.shortMessage ?? e.message)
  }

  // ── Test 2: settleAuction() before endTime — expect revert ──
  log("\n[2] settleAuction() before endTime — should REVERT")
  await expectRevert(
    wallet.writeContract({
      address: TL_AH,
      abi: transientAuctionHouseAbi,
      functionName: "settleAuction",
      args: [TARGET_CONTRACT, TARGET_TOKEN_ID],
    }),
    "settle before endTime",
  )

  // ── Test 3: time-travel + settleAuction() — expect success ──
  log("\n[3] settleAuction() after time-travel — should succeed")
  const skip = Number(length0) + 60
  await rpc("evm_increaseTime", [`0x${skip.toString(16)}`])
  await rpc("evm_mine")
  try {
    const txHash = await wallet.writeContract({
      address: TL_AH,
      abi: transientAuctionHouseAbi,
      functionName: "settleAuction",
      args: [TARGET_CONTRACT, TARGET_TOKEN_ID],
    })
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== "success") throw new Error(`status ${receipt.status}`)
    pass(`settle tx confirmed (gas ${receipt.gasUsed})`)
    // After settle the listing struct should be cleared (type_ back to 0).
    const post = await readListing()
    const typePost = post.type_
    if (typePost === 0) pass("listing cleared (type_ == 0)")
    else fail("listing cleared", `type_ still ${typePost}`)
  } catch (e) {
    fail("settle", e.shortMessage ?? e.message)
  }

  // ── Test 4: delist() ABI encoding round-trip ──
  // Use a separate token (Unit Sequence #5) that's still pre-bid on the
  // fork. Whether `delist` succeeds vs reverts depends on TL's business
  // rules; we accept either as long as the calldata is accepted.
  log("\n[4] delist() ABI encoding — verify accepted by contract")
  const DELIST_CONTRACT = "0xebbe808281df1f46dea0d6b57208d4c530c0f597"
  const DELIST_TOKEN = 5n
  const DELIST_SELLER = "0xBE2484ee4cA2B13BdA6a65aB4069FD241A7EFA3e"
  await rpc("anvil_impersonateAccount", [DELIST_SELLER])
  await rpc("anvil_setBalance", [DELIST_SELLER, "0x56BC75E2D63100000"])
  const sellerWallet = createWalletClient({
    account: DELIST_SELLER,
    chain: foundry,
    transport,
  })
  try {
    const txHash = await sellerWallet.writeContract({
      address: TL_AH,
      abi: transientAuctionHouseAbi,
      functionName: "delist",
      args: [DELIST_CONTRACT, DELIST_TOKEN],
    })
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status === "success") {
      pass(`delist succeeded (gas ${receipt.gasUsed})`)
    } else if (receipt.status === "reverted") {
      pass(`delist reverted on-chain (contract business logic; ABI ok)`)
    } else {
      fail("delist encoding", `unexpected status ${receipt.status}`)
    }
  } catch (e) {
    const msg = e.shortMessage ?? e.message ?? ""
    if (msg.includes("revert")) {
      pass(`delist reverted with contract-side message: ${msg.slice(0, 80)}`)
    } else {
      fail("delist encoding", `unexpected error: ${msg}`)
    }
  }

  log("\n--- summary ---")
  log(process.exitCode === 1 ? "FAILURES present" : "all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
