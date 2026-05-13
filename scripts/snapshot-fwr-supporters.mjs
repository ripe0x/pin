// Re-snapshot the FundingWorksRipe supporter list to a static JSON
// file. The campaign is closed, so the runtime footer reads the JSON
// directly — see apps/web/src/lib/funding-works-supporters.ts.
//
// Only run this if you need to refresh the data (e.g. a supporter set
// a reverse-ENS record after the last snapshot, or a late mint sneaks
// in). On a normal day the JSON in the repo is the source of truth and
// this script doesn't run.
//
// Usage:
//   npm run snapshot:fwr-supporters
//
// Reads ALCHEMY_MAINNET_URL or ALCHEMY_API_KEY from apps/web/.env.local.
// Writes apps/web/src/data/fwr-supporters.json.

import { createPublicClient, http, parseAbiItem } from "viem"
import { mainnet } from "viem/chains"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, "..")
const OUT_PATH = join(
  REPO_ROOT,
  "apps/web/src/data/fwr-supporters.json",
)

const FWR_CONTRACT =
  process.env.NEXT_PUBLIC_FWR_CONTRACT_ADDRESS ??
  "0xA78846573c4eDA142DFe10335F560a5cF3486894"
const FWR_DEPLOY_BLOCK = BigInt(
  process.env.NEXT_PUBLIC_FWR_DEPLOY_BLOCK ?? "25009880",
)

const url =
  process.env.ALCHEMY_MAINNET_URL ??
  (process.env.ALCHEMY_API_KEY
    ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    : null)

if (!url) {
  console.error(
    "ALCHEMY_MAINNET_URL or ALCHEMY_API_KEY must be set. (npm run uses --env-file=apps/web/.env.local; set there.)",
  )
  process.exit(1)
}

const TOKEN_MINTED = parseAbiItem(
  "event TokenMinted(address indexed minter, uint256 indexed tokenId, bytes32 mintHash)",
)

const client = createPublicClient({ chain: mainnet, transport: http(url) })

const SCAN_CHUNK = 2_000_000n
const SCAN_FLOOR = 10_000n

async function scanLogs(fromBlock, toBlock) {
  const out = []
  for (let start = fromBlock; start <= toBlock; start += SCAN_CHUNK) {
    const end =
      start + SCAN_CHUNK - 1n > toBlock ? toBlock : start + SCAN_CHUNK - 1n
    try {
      const logs = await client.getLogs({
        address: FWR_CONTRACT,
        event: TOKEN_MINTED,
        fromBlock: start,
        toBlock: end,
      })
      out.push(...logs)
    } catch (err) {
      if (end - start > SCAN_FLOOR) {
        const mid = start + (end - start) / 2n
        out.push(...(await scanLogs(start, mid)))
        out.push(...(await scanLogs(mid + 1n, end)))
      } else {
        throw err
      }
    }
  }
  return out
}

async function resolveEnsName(addr) {
  // viem's getEnsName performs reverse resolution AND verifies the
  // forward record matches — accepting whatever it returns is safe.
  try {
    return await client.getEnsName({ address: addr })
  } catch {
    return null
  }
}

console.log(`Scanning ${FWR_CONTRACT} from block ${FWR_DEPLOY_BLOCK}…`)
const head = await client.getBlockNumber()
const logs = await scanLogs(FWR_DEPLOY_BLOCK, head)
console.log(`  ${logs.length} TokenMinted events through block ${head}`)

const sorted = [...logs].sort((a, b) => {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber < b.blockNumber ? -1 : 1
  }
  return (a.logIndex ?? 0) - (b.logIndex ?? 0)
})

const ordered = []
const counts = new Map()
const seen = new Set()
for (const log of sorted) {
  const minter = log.args.minter
  if (!minter) continue
  const lower = minter.toLowerCase()
  if (!seen.has(lower)) {
    seen.add(lower)
    ordered.push(lower)
  }
  counts.set(lower, (counts.get(lower) ?? 0) + 1)
}

console.log(`  ${ordered.length} unique supporters; resolving ENS…`)
const names = await Promise.all(ordered.map((a) => resolveEnsName(a)))

const supporters = ordered.map((addr, i) => ({
  address: addr,
  ensName: names[i],
  mintCount: counts.get(addr) ?? 1,
}))

const payload = {
  cursorBlock: head.toString(),
  snapshotAt: new Date().toISOString(),
  supporters,
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + "\n")
console.log(
  `Wrote ${supporters.length} supporters to ${OUT_PATH.replace(REPO_ROOT + "/", "")}`,
)
