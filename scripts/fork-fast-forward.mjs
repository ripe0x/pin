#!/usr/bin/env node
/**
 * Fast-forward the local Anvil fork by N seconds (or with a human-friendly
 * suffix like 24h / 30m / 7d) and mine a block so the new timestamp sticks.
 *
 *   node scripts/fork-fast-forward.mjs <duration> [--rpc <url>]
 *
 * Examples:
 *   node scripts/fork-fast-forward.mjs 24h        # 1 day
 *   node scripts/fork-fast-forward.mjs 30m        # 30 minutes
 *   node scripts/fork-fast-forward.mjs 86400      # bare seconds also fine
 */
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith("--"))
const rpcFlagIdx = args.indexOf("--rpc")
const rpcUrl = rpcFlagIdx >= 0 ? args[rpcFlagIdx + 1] : "http://localhost:8545"
const durationArg = positional[0]

if (!durationArg) {
  console.error("Usage: node scripts/fork-fast-forward.mjs <duration> [--rpc <url>]")
  console.error("  duration: bare seconds (86400) or suffix (24h, 30m, 7d)")
  process.exit(1)
}

function parseDuration(input) {
  const m = input.match(/^(\d+)\s*([smhd]?)$/i)
  if (!m) throw new Error(`bad duration "${input}"`)
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  return n * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[unit]
}

const seconds = parseDuration(durationArg)

const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })

const before = await client.getBlock({ blockTag: "latest" })
console.log(
  `Before:  block ${before.number}  ts ${before.timestamp}  (${new Date(Number(before.timestamp) * 1000).toISOString()})`,
)

await fetch(rpcUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "evm_increaseTime",
    params: [seconds],
  }),
})
await fetch(rpcUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }),
})

const after = await client.getBlock({ blockTag: "latest" })
const deltaSec = Number(after.timestamp - before.timestamp)
console.log(
  `After:   block ${after.number}  ts ${after.timestamp}  (${new Date(Number(after.timestamp) * 1000).toISOString()})`,
)
console.log(`✅ Advanced ${deltaSec}s (${(deltaSec / 3600).toFixed(2)}h)`)
