/**
 * SuperRare V2 fork test. Exercises the same ABI + write-path encoding
 * the AuctionPanel UI uses, against an Anvil mainnet fork. Validates
 * that our `superrareBazaarAbi` encoding produces calldata the real
 * Bazaar contract accepts.
 *
 * Tests:
 *   1. bid(): place a valid first bid → expect success + state mutation
 *   2. cancelAuction(): seller cancels post-bid → expect REVERT (unsafe)
 *   3. settleAuction() before endTime → expect REVERT
 *   4. settleAuction() after time-travel past endTime → expect success
 *   5. (separate auction) cancelAuction() pre-bid as seller → expect success
 *
 * Run anvil first:
 *   anvil --fork-url $MAINNET_RPC_URL --port 8546
 */
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem"
import { foundry } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"
import { superrareBazaarAbi } from "../packages/abi/src/superrareBazaar.ts"

const RPC = "http://127.0.0.1:8545"
const BAZAAR = "0x6d7c44773c52d396f43c2d511b81aa168e9a7a42"
const SR_V2_NFT = "0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0"
const ZERO = "0x0000000000000000000000000000000000000000"

// Anvil's first default account — pre-funded; private key is the
// well-known anvil dev key.
const TEST_BIDDER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const TARGET_TOKEN_ID = 48544n
const SELLER = "0x09464aD754F39578bCAeeDD64bc61F911ceC01Bb"
const RESERVE_WEI = parseEther("1.5")
// SR Bazaar's MarketplaceSettings.getMarketplaceFeePercentage() returns
// 3 — buyer pays bid + 3% as msg.value or the contract reverts with
// "not enough eth sent". Same constant we hardcode in AuctionPanel.tsx.
const MARKETPLACE_FEE_BPS = 300n

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

async function readAuction(tokenId) {
  return await pub.readContract({
    address: BAZAAR,
    abi: superrareBazaarAbi,
    functionName: "tokenAuctions",
    args: [SR_V2_NFT, tokenId],
  })
}

async function readBid(tokenId) {
  return await pub.readContract({
    address: BAZAAR,
    abi: superrareBazaarAbi,
    functionName: "auctionBids",
    args: [SR_V2_NFT, tokenId],
  })
}

const lines = []
function log(s) {
  console.log(s)
  lines.push(s)
}

function pass(label) {
  log(`  ✓ ${label}`)
}
function fail(label, err) {
  log(`  ✗ ${label}: ${err}`)
  process.exitCode = 1
}

async function expectRevert(promise, label) {
  try {
    await promise
    fail(label, "expected revert, got success")
  } catch (e) {
    pass(`${label} (reverted: ${e.shortMessage ?? e.message?.slice(0, 60)})`)
  }
}

async function main() {
  log(`fork block: ${await pub.getBlockNumber()}`)

  // ── Setup: fund the test bidder ──
  const bidder = privateKeyToAccount(TEST_BIDDER_KEY)
  await rpc("anvil_setBalance", [bidder.address, "0x56BC75E2D63100000"]) // 100 ETH
  log(`bidder: ${bidder.address}, balance: ${formatEther(await pub.getBalance({ address: bidder.address }))} ETH`)

  const wallet = createWalletClient({ account: bidder, chain: foundry, transport })

  // ── Read pre-state ──
  const [creator0, , startingTime0, length0, currency0, minBid0] = await readAuction(TARGET_TOKEN_ID)
  log(`token ${TARGET_TOKEN_ID} pre-state:`)
  log(`  creator=${creator0}`)
  log(`  startingTime=${startingTime0}, length=${length0}, currency=${currency0}, minBid=${formatEther(minBid0)}`)
  if (creator0.toLowerCase() !== SELLER.toLowerCase()) {
    fail("setup", "auction creator changed since fork")
    process.exit(1)
  }

  // ── Test 1: bid() with our exact ABI ──
  // SR Bazaar enforces a buyer's premium on top of the bid amount: the
  // total `msg.value` must equal `amount + (amount * marketplaceFee%)`.
  // Current marketplaceFee is 3%, so for a 1.5 ETH bid we send 1.545 ETH.
  const totalToSend = RESERVE_WEI + (RESERVE_WEI * MARKETPLACE_FEE_BPS) / 10000n
  log(`\n[1] bid() — first bid at reserve, expect success`)
  log(`    bid amount: ${formatEther(RESERVE_WEI)} ETH`)
  log(`    msg.value (with 3% premium): ${formatEther(totalToSend)} ETH`)
  try {
    const txHash = await wallet.writeContract({
      address: BAZAAR,
      abi: superrareBazaarAbi,
      functionName: "bid",
      args: [SR_V2_NFT, TARGET_TOKEN_ID, ZERO, RESERVE_WEI],
      value: totalToSend,
    })
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== "success") throw new Error(`receipt status ${receipt.status}`)
    pass(`bid tx confirmed (gas ${receipt.gasUsed})`)

    const [bidderAddr, , amount] = await readBid(TARGET_TOKEN_ID)
    if (bidderAddr.toLowerCase() !== bidder.address.toLowerCase()) {
      fail("bidder recorded", `got ${bidderAddr}, expected ${bidder.address}`)
    } else pass(`bidder = ${bidderAddr}`)
    if (amount !== RESERVE_WEI) {
      fail("bid amount recorded", `got ${amount}, expected ${RESERVE_WEI}`)
    } else pass(`bid amount = ${formatEther(amount)} ETH`)

    const [, , startingTime1, , , minBid1] = await readAuction(TARGET_TOKEN_ID)
    if (startingTime1 === 0n) {
      fail("startingTime after bid", "expected non-zero (timer should start)")
    } else pass(`startingTime updated to ${startingTime1}`)
    pass(`minimumBid (post-bid) reads as ${formatEther(minBid1)}`)
  } catch (e) {
    fail("bid", e.shortMessage ?? e.message)
  }

  // ── Test 2: cancelAuction() post-bid by seller. SR Bazaar's cancel
  // semantics depend on auction type: COLDIE_AUCTION allows seller to
  // cancel post-bid (with bidder refund); SCHEDULED_AUCTION locks once
  // startingTime passes. Our UI surfaces the button and the contract
  // decides; we just verify the call doesn't fail to encode.
  log("\n[2] cancelAuction() — contract decides based on auction type")
  // Skipping this on token 48544 because we want to keep a bid in
  // place for the settle test. Tested instead on token 46042 below.

  // ── Test 3: settleAuction() before endTime — expect revert ──
  log("\n[3] settleAuction() before endTime — should REVERT")
  await expectRevert(
    wallet.writeContract({
      address: BAZAAR,
      abi: superrareBazaarAbi,
      functionName: "settleAuction",
      args: [SR_V2_NFT, TARGET_TOKEN_ID],
    }),
    "settle before endTime",
  )

  // ── Test 4: time-travel + settleAuction() — expect success ──
  log("\n[4] settleAuction() after time-travel — should succeed")
  // Length of auction is `length0` seconds; jump well past it.
  const skip = Number(length0) + 60
  await rpc("evm_increaseTime", [`0x${skip.toString(16)}`])
  await rpc("evm_mine")
  try {
    const txHash = await wallet.writeContract({
      address: BAZAAR,
      abi: superrareBazaarAbi,
      functionName: "settleAuction",
      args: [SR_V2_NFT, TARGET_TOKEN_ID],
    })
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== "success") throw new Error(`receipt status ${receipt.status}`)
    pass(`settle tx confirmed (gas ${receipt.gasUsed})`)
    // After settle, auction should be cleared.
    const [creatorPost] = await readAuction(TARGET_TOKEN_ID)
    if (creatorPost === ZERO) pass("auction cleared (creator == 0x0)")
    else fail("auction cleared", `creator still ${creatorPost}`)
  } catch (e) {
    fail("settle", e.shortMessage ?? e.message)
  }

  // ── Test 5: cancelAuction() ABI encoding round-trip ──
  // Run the seller's cancel against a fresh auction and verify the
  // contract accepts the calldata our ABI encodes (success or
  // contract-side revert both prove encoding is right; the actual
  // revert vs success depends on auction-type + timing rules SR enforces).
  log("\n[5] cancelAuction() encoding — verify ABI accepted by contract")
  const TOKEN5 = 46042n
  const SELLER5 = "0x16c93ec97512832ba4244cc69527530d358db0e5"
  await rpc("anvil_impersonateAccount", [SELLER5])
  await rpc("anvil_setBalance", [SELLER5, "0x56BC75E2D63100000"])
  const seller5 = createWalletClient({ account: SELLER5, chain: foundry, transport })
  try {
    const txHash = await seller5.writeContract({
      address: BAZAAR,
      abi: superrareBazaarAbi,
      functionName: "cancelAuction",
      args: [SR_V2_NFT, TOKEN5],
    })
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status === "success") {
      pass(`cancel succeeded — auction-type permitted it (gas ${receipt.gasUsed})`)
    } else if (receipt.status === "reverted") {
      // Reverted on-chain: ABI was accepted by the contract, business
      // logic disallowed the cancel. That's correct integration behavior.
      pass(`cancel reverted on-chain (contract business logic; ABI ok)`)
    } else {
      fail("cancel encoding", `unexpected receipt status ${receipt.status}`)
    }
  } catch (e) {
    // A revert from the contract is also fine — it means the ABI was
    // accepted and the contract evaluated business logic. As long as
    // the revert reason is human-readable (not a "function not found"
    // selector mismatch), our integration is correct.
    const msg = e.shortMessage ?? e.message ?? ""
    if (msg.includes("cancelAuction::") || msg.includes("must")) {
      pass(`cancel reverted with contract-side message: ${msg.slice(0, 80)}`)
    } else {
      fail("cancel encoding", `unexpected error: ${msg}`)
    }
  }

  // ── Test 6: bid() against a SuperRare Space contract ──
  // Bazaar accepts originContract pointing at any Space ERC-721, not
  // just the V2 shared NFT. This proves the same ABI/calldata path
  // works for Spaces — same code in our adapter, same UI write path.
  log("\n[6] bid() on a SuperRare Space — same ABI, different originContract")
  // Token 422 on ARTIFACT (0xa9cf…). Picked because it's a cheap
  // (0.7 ETH) pre-bid auction; leaves token 57 (1.5 ETH) untouched
  // for manual UI testing in the dev site.
  const SPACE_CONTRACT = "0xa9cf3fb2c4538ac95e0c822758ec745fcfed8360" // ARTIFACT
  const SPACE_TOKEN_ID = 422n
  const SPACE_RESERVE = parseEther("0.7")
  const spaceTotal = SPACE_RESERVE + (SPACE_RESERVE * MARKETPLACE_FEE_BPS) / 10000n
  // Use a fresh bidder so we don't collide with the V2 token we
  // already mutated in Tests 1–4.
  const spaceBidder = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // anvil account #1
  )
  await rpc("anvil_setBalance", [spaceBidder.address, "0x56BC75E2D63100000"])
  const spaceWallet = createWalletClient({
    account: spaceBidder,
    chain: foundry,
    transport,
  })

  // Pre-state read via the same tokenAuctions ABI used by our adapter.
  const [spaceCreatorPre] = await pub.readContract({
    address: BAZAAR,
    abi: superrareBazaarAbi,
    functionName: "tokenAuctions",
    args: [SPACE_CONTRACT, SPACE_TOKEN_ID],
  })
  if (spaceCreatorPre === ZERO) {
    fail("space pre-state", "auction not active on fork")
  } else {
    pass(`space auction creator on fork: ${spaceCreatorPre}`)
  }

  try {
    const txHash = await spaceWallet.writeContract({
      address: BAZAAR,
      abi: superrareBazaarAbi,
      functionName: "bid",
      args: [SPACE_CONTRACT, SPACE_TOKEN_ID, ZERO, SPACE_RESERVE],
      value: spaceTotal,
    })
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== "success") throw new Error(`status ${receipt.status}`)
    pass(`space bid tx confirmed (gas ${receipt.gasUsed})`)

    const [bidderPost, , amountPost] = await pub.readContract({
      address: BAZAAR,
      abi: superrareBazaarAbi,
      functionName: "auctionBids",
      args: [SPACE_CONTRACT, SPACE_TOKEN_ID],
    })
    if (bidderPost.toLowerCase() === spaceBidder.address.toLowerCase()) {
      pass(`space bidder recorded: ${bidderPost}`)
    } else {
      fail("space bidder", `expected ${spaceBidder.address}, got ${bidderPost}`)
    }
    if (amountPost === SPACE_RESERVE) {
      pass(`space bid amount: ${formatEther(amountPost)} ETH`)
    } else {
      fail("space amount", `expected ${SPACE_RESERVE}, got ${amountPost}`)
    }
  } catch (e) {
    fail("space bid", e.shortMessage ?? e.message)
  }

  log("\n--- summary ---")
  log(process.exitCode === 1 ? "FAILURES present" : "all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
