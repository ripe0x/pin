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

  // ── Test 4: delist + relist round-trip ──
  // Take an active pre-bid auction, have the seller delist it (NFT
  // returns to seller, listing cleared), then re-list it on the same
  // Auction House with new params and verify the fresh listing.
  log("\n[4] delist + relist round-trip — verify both write paths")
  const RELIST_CONTRACT = "0x3910dc95176be74fe94974922496219c6e2da3e1"
  const RELIST_TOKEN = 4n
  const RELIST_SELLER = "0x03F916d727876DA993F0D59CF08168Dd8F571074"

  // Pre-state: confirm active type-2 auction with auction-house custody.
  const before = await pub.readContract({
    address: TL_AH,
    abi: transientAuctionHouseAbi,
    functionName: "getListing",
    args: [RELIST_CONTRACT, RELIST_TOKEN],
  })
  const beforeId = before.id
  if (before.type_ === 0 || before.seller.toLowerCase() !== RELIST_SELLER.toLowerCase()) {
    fail("relist setup", "expected active listing not found on fork")
    log("\n--- summary ---")
    log(process.exitCode === 1 ? "FAILURES present" : "all checks passed")
    return
  }
  const ownerPre = await pub.readContract({
    address: RELIST_CONTRACT,
    abi: [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }],
    functionName: "ownerOf",
    args: [RELIST_TOKEN],
  })
  if (ownerPre.toLowerCase() !== TL_AH.toLowerCase()) {
    fail("relist setup", `expected AH custody pre-delist, got ${ownerPre}`)
  } else {
    pass(`pre: AH custodies token (id=${beforeId})`)
  }

  await rpc("anvil_impersonateAccount", [RELIST_SELLER])
  await rpc("anvil_setBalance", [RELIST_SELLER, "0x56BC75E2D63100000"])
  const seller = createWalletClient({
    account: RELIST_SELLER,
    chain: foundry,
    transport,
  })

  // ── Delist ──
  try {
    const txHash = await seller.writeContract({
      address: TL_AH,
      abi: transientAuctionHouseAbi,
      functionName: "delist",
      args: [RELIST_CONTRACT, RELIST_TOKEN],
    })
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== "success") throw new Error(`status ${receipt.status}`)
    pass(`delist tx confirmed (gas ${receipt.gasUsed})`)

    const afterDelist = await pub.readContract({
      address: TL_AH,
      abi: transientAuctionHouseAbi,
      functionName: "getListing",
      args: [RELIST_CONTRACT, RELIST_TOKEN],
    })
    if (afterDelist.type_ === 0) pass("listing cleared (type_ == 0)")
    else fail("listing cleared", `type_ still ${afterDelist.type_}`)

    const ownerPost = await pub.readContract({
      address: RELIST_CONTRACT,
      abi: [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }],
      functionName: "ownerOf",
      args: [RELIST_TOKEN],
    })
    if (ownerPost.toLowerCase() === RELIST_SELLER.toLowerCase()) {
      pass(`NFT returned to seller (${ownerPost})`)
    } else {
      fail("ownerOf after delist", `got ${ownerPost}, expected ${RELIST_SELLER}`)
    }
  } catch (e) {
    fail("delist", e.shortMessage ?? e.message)
  }

  // ── Relist ──
  // The seller previously approved the Auction House for transfers
  // (otherwise the original list() would have failed). That approval
  // is per-(owner, operator) and persists across delist/relist —
  // ERC-721 setApprovalForAll doesn't reset on transfer.
  const NEW_RESERVE = parseEther("0.05")
  const NEW_DURATION = 86400n
  // list(address nftAddress, uint256 tokenId, uint8 type_,
  //      address payoutReceiver, address currencyAddress,
  //      uint256 openTime, uint256 reservePrice,
  //      uint256 auctionDuration, uint256 buyNowPrice)
  const listAbi = [
    {
      type: "function",
      name: "list",
      stateMutability: "nonpayable",
      inputs: [
        { name: "nftAddress", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "type_", type: "uint8" },
        { name: "payoutReceiver", type: "address" },
        { name: "currencyAddress", type: "address" },
        { name: "openTime", type: "uint256" },
        { name: "reservePrice", type: "uint256" },
        { name: "auctionDuration", type: "uint256" },
        { name: "buyNowPrice", type: "uint256" },
      ],
      outputs: [],
    },
  ]
  try {
    const txHash = await seller.writeContract({
      address: TL_AH,
      abi: listAbi,
      functionName: "list",
      args: [
        RELIST_CONTRACT,
        RELIST_TOKEN,
        2, // reserve auction
        RELIST_SELLER, // payoutReceiver
        ZERO, // ETH
        0n, // openTime: 0 = open now
        NEW_RESERVE,
        NEW_DURATION,
        0n, // buyNowPrice
      ],
    })
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== "success") throw new Error(`status ${receipt.status}`)
    pass(`list tx confirmed (gas ${receipt.gasUsed})`)

    const after = await pub.readContract({
      address: TL_AH,
      abi: transientAuctionHouseAbi,
      functionName: "getListing",
      args: [RELIST_CONTRACT, RELIST_TOKEN],
    })
    if (after.type_ === 2) pass(`new listing type_ = 2 (reserve auction)`)
    else fail("relist type", `expected 2, got ${after.type_}`)
    if (after.reservePrice === NEW_RESERVE) {
      pass(`new reservePrice = ${formatEther(after.reservePrice)} ETH`)
    } else {
      fail("relist reserve", `expected ${NEW_RESERVE}, got ${after.reservePrice}`)
    }
    if (after.id !== beforeId) {
      pass(`new listing id ${after.id} ≠ old id ${beforeId} (fresh listing)`)
    } else {
      fail("relist id", "id didn't change — listing not actually fresh")
    }

    const ownerPost = await pub.readContract({
      address: RELIST_CONTRACT,
      abi: [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }],
      functionName: "ownerOf",
      args: [RELIST_TOKEN],
    })
    if (ownerPost.toLowerCase() === TL_AH.toLowerCase()) {
      pass(`NFT custodied by Auction House post-relist`)
    } else {
      fail("ownerOf after relist", `expected AH, got ${ownerPost}`)
    }
  } catch (e) {
    fail("relist", e.shortMessage ?? e.message)
  }

  log("\n--- summary ---")
  log(process.exitCode === 1 ? "FAILURES present" : "all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
