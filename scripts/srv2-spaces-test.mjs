import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem"
import { foundry } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"
import { superrareBazaarAbi } from "/Users/dd/foundation/packages/abi/src/superrareBazaar.ts"

const RPC = "http://127.0.0.1:8545"
const BAZAAR = "0x6d7c44773c52d396f43c2d511b81aa168e9a7a42"
const ZERO = "0x0000000000000000000000000000000000000000"
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

const SPACE_CONTRACT = "0xa9cf3fb2c4538ac95e0c822758ec745fcfed8360" // ARTIFACT
const SPACE_TOKEN_ID = 422n
const SPACE_RESERVE = parseEther("0.7")

console.log(`\n[Spaces bid test] contract=${SPACE_CONTRACT} token=${SPACE_TOKEN_ID}`)
console.log(`block: ${await pub.getBlockNumber()}`)

// Pre-state read
const [creator] = await pub.readContract({
  address: BAZAAR,
  abi: superrareBazaarAbi,
  functionName: "tokenAuctions",
  args: [SPACE_CONTRACT, SPACE_TOKEN_ID],
})
console.log(`auction creator (pre): ${creator}`)
if (creator === ZERO) {
  console.error("✗ no active auction on this token")
  process.exit(1)
}

// Fund a fresh bidder (anvil account #2 — different from user's wallet)
const bidder = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
)
await rpc("anvil_setBalance", [bidder.address, "0x56BC75E2D63100000"])
console.log(`bidder: ${bidder.address}`)

const wallet = createWalletClient({ account: bidder, chain: foundry, transport })

// Bid: send reserve + 3% premium
const total = SPACE_RESERVE + (SPACE_RESERVE * MARKETPLACE_FEE_BPS) / 10000n
console.log(`bid: ${formatEther(SPACE_RESERVE)} ETH + 3% premium = ${formatEther(total)} ETH msg.value`)

try {
  const txHash = await wallet.writeContract({
    address: BAZAAR,
    abi: superrareBazaarAbi,
    functionName: "bid",
    args: [SPACE_CONTRACT, SPACE_TOKEN_ID, ZERO, SPACE_RESERVE],
    value: total,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== "success") throw new Error(`status ${receipt.status}`)
  console.log(`✓ bid tx confirmed (gas ${receipt.gasUsed})`)

  const [bidderPost, , amountPost] = await pub.readContract({
    address: BAZAAR,
    abi: superrareBazaarAbi,
    functionName: "auctionBids",
    args: [SPACE_CONTRACT, SPACE_TOKEN_ID],
  })

  if (bidderPost.toLowerCase() === bidder.address.toLowerCase()) {
    console.log(`✓ bidder recorded on-chain: ${bidderPost}`)
  } else {
    console.error(`✗ bidder mismatch: ${bidderPost} vs ${bidder.address}`)
    process.exit(1)
  }

  if (amountPost === SPACE_RESERVE) {
    console.log(`✓ amount recorded: ${formatEther(amountPost)} ETH`)
  } else {
    console.error(`✗ amount mismatch: ${amountPost} vs ${SPACE_RESERVE}`)
    process.exit(1)
  }

  console.log(`\n✅ Spaces bid path works end-to-end via the same Bazaar ABI`)
} catch (e) {
  console.error(`✗ bid failed: ${e.shortMessage ?? e.message}`)
  process.exit(1)
}
