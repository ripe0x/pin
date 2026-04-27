#!/usr/bin/env node
/**
 * Reclaim a sold NFT on the local Anvil fork by impersonating the current
 * owner and transferring the token to a recipient. Useful for testing the
 * "list for auction" flow against tokens you no longer own on mainnet.
 *
 *   node scripts/fork-reclaim-token.mjs <contract> <tokenId> [recipient] [--rpc <url>]
 *
 * Defaults:
 *   recipient → YOUR_ADDRESS from apps/web/.env.local
 *   rpc       → http://localhost:8545
 *
 * Examples:
 *   # send Foundation tokenId 12345 back to YOUR_ADDRESS
 *   node scripts/fork-reclaim-token.mjs 0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405 12345
 *
 *   # explicit recipient (e.g. ripe0x.eth)
 *   node scripts/fork-reclaim-token.mjs 0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405 12345 0xCB43078C32423F5348Cab5885911C3B5faE217F9
 */
import {
  createPublicClient,
  createTestClient,
  http,
  parseEther,
  publicActions,
  walletActions,
  getAddress,
  defineChain,
} from "viem"

const anvilFork = defineChain({
  id: 31337,
  name: "Anvil Fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://localhost:8545"] } },
})
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadEnv(path) {
  try {
    const raw = readFileSync(path, "utf8")
    const out = {}
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) out[m[1]] = m[2]
    }
    return out
  } catch {
    return {}
  }
}

const env = loadEnv(join(__dirname, "..", "apps", "web", ".env.local"))

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith("--"))
const rpcFlagIdx = args.indexOf("--rpc")
const rpcFlag = rpcFlagIdx >= 0 ? args[rpcFlagIdx + 1] : null

const contractRaw = positional[0]
const tokenIdRaw = positional[1]
const recipientRaw = positional[2] ?? env.YOUR_ADDRESS

if (!contractRaw || !tokenIdRaw || !recipientRaw) {
  console.error(
    "Usage: node scripts/fork-reclaim-token.mjs <contract> <tokenId> [recipient]\n" +
      "  (recipient defaults to YOUR_ADDRESS from apps/web/.env.local)",
  )
  process.exit(1)
}

const contract = getAddress(contractRaw)
const tokenId = BigInt(tokenIdRaw)
const recipient = getAddress(recipientRaw)
const rpcUrl = rpcFlag ?? "http://localhost:8545"

const erc721Abi = [
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
]

// Anvil works as a forked mainnet, so use the mainnet chain config but with
// a test client for the impersonate / setBalance cheats.
const publicClient = createPublicClient({
  chain: anvilFork,
  transport: http(rpcUrl),
})

const testClient = createTestClient({
  chain: anvilFork,
  mode: "anvil",
  transport: http(rpcUrl),
}).extend(publicActions).extend(walletActions)

console.log(`RPC:        ${rpcUrl}`)
console.log(`Contract:   ${contract}`)
console.log(`Token ID:   ${tokenId.toString()}`)
console.log(`Recipient:  ${recipient}`)
console.log()

// 1. Confirm fork is alive
try {
  const block = await publicClient.getBlockNumber()
  console.log(`✓ Fork alive at block ${block}`)
} catch (e) {
  console.error(`✘ Cannot reach RPC at ${rpcUrl}: ${e.message}`)
  console.error("  Is Anvil running? Try: anvil --fork-url <mainnet-url> --chain-id 31337")
  process.exit(1)
}

// 2. Look up current owner
let currentOwner
try {
  currentOwner = await publicClient.readContract({
    address: contract,
    abi: erc721Abi,
    functionName: "ownerOf",
    args: [tokenId],
  })
} catch (e) {
  console.error(`✘ ownerOf(${tokenId}) reverted: ${e.shortMessage ?? e.message}`)
  console.error("  Is this an ERC721 token? Burned? Wrong contract?")
  process.exit(1)
}

console.log(`✓ Current owner: ${currentOwner}`)

if (getAddress(currentOwner) === recipient) {
  console.log("→ Recipient already owns this token. Nothing to do.")
  process.exit(0)
}

// 3. Impersonate the current owner and fund them for gas
console.log(`→ Impersonating ${currentOwner}…`)
await testClient.impersonateAccount({ address: currentOwner })
await testClient.setBalance({
  address: currentOwner,
  value: parseEther("1"),
})

// 4. Send the transfer tx
console.log(`→ Sending transferFrom(${currentOwner}, ${recipient}, ${tokenId})…`)
let txHash
try {
  txHash = await testClient.writeContract({
    account: currentOwner,
    address: contract,
    abi: erc721Abi,
    functionName: "transferFrom",
    args: [currentOwner, recipient, tokenId],
    chain: anvilFork,
  })
} catch (e) {
  console.error(`✘ transferFrom reverted: ${e.shortMessage ?? e.message}`)
  await testClient.stopImpersonatingAccount({ address: currentOwner })
  process.exit(1)
}

console.log(`  tx: ${txHash}`)

const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
console.log(`  status: ${receipt.status}  block: ${receipt.blockNumber}`)

// 5. Stop impersonating
await testClient.stopImpersonatingAccount({ address: currentOwner })

// 6. Verify the new owner
const newOwner = await publicClient.readContract({
  address: contract,
  abi: erc721Abi,
  functionName: "ownerOf",
  args: [tokenId],
})

if (getAddress(newOwner) === recipient) {
  console.log(`\n✅ Done. ${recipient} now owns token ${tokenId}.`)
} else {
  console.error(`\n✘ Owner check failed. Expected ${recipient}, got ${newOwner}.`)
  process.exit(1)
}
