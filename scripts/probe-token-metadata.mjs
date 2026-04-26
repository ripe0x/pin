#!/usr/bin/env node
/**
 * Probe what `resolveTokenMetadataDirect` does for a given (contract, tokenId).
 * Mirrors the resolver in apps/web/src/lib/onchain-discovery.ts so we can see
 * exactly which step fails when the page falls through to the placeholder.
 *
 *   node scripts/probe-token-metadata.mjs <contract> <tokenId> [--rpc <url>]
 *
 * Defaults to probing both the configured local RPC (.env.local PONDER_URL'd
 * fork) AND mainnet Alchemy, since the dev page reads from whatever
 * NEXT_PUBLIC_ALCHEMY_MAINNET_URL points at.
 */
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
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

const contract = positional[0]
const tokenId = positional[1]

if (!contract || !tokenId) {
  console.error(
    "Usage: node scripts/probe-token-metadata.mjs <contract> <tokenId> [--rpc <url>]",
  )
  process.exit(1)
}

const id = BigInt(tokenId)

const erc721Abi = [
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
]

const erc1155UriAbi = [
  {
    type: "function",
    name: "uri",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
]

function ipfsToHttp(uri) {
  if (!uri.startsWith("ipfs://")) return uri
  let cid = uri.replace("ipfs://", "")
  if (cid.startsWith("ipfs/")) cid = cid.replace("ipfs/", "")
  return `https://nftstorage.link/ipfs/${cid}`
}

async function probeRpc(label, rpcUrl) {
  console.log(`\n━━━ ${label}  (${rpcUrl}) ━━━`)
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })

  let uriString = null
  let source = null

  try {
    uriString = await client.readContract({
      address: contract,
      abi: erc721Abi,
      functionName: "tokenURI",
      args: [id],
    })
    source = "tokenURI (ERC721)"
  } catch (e) {
    console.log(`  tokenURI(${tokenId}) reverted: ${shortErr(e)}`)
    try {
      uriString = await client.readContract({
        address: contract,
        abi: erc1155UriAbi,
        functionName: "uri",
        args: [id],
      })
      source = "uri (ERC1155)"
    } catch (e2) {
      console.log(`  uri(${tokenId}) reverted: ${shortErr(e2)}`)
    }
  }

  if (!uriString) {
    console.log("  ⛔ Both tokenURI and uri failed → resolver returns null")
    return
  }

  console.log(`  ✓ ${source} returned: ${JSON.stringify(uriString)}`)

  const idHex = id.toString(16).padStart(64, "0")
  const resolvedUri = uriString.replace(/\{id\}/g, idHex)
  if (resolvedUri !== uriString) {
    console.log(`  → after {id} substitution: ${resolvedUri}`)
  }

  const httpUrl = ipfsToHttp(resolvedUri)
  console.log(`  → http URL: ${httpUrl}`)

  try {
    const res = await fetch(httpUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      cache: "no-store",
    })
    const contentType = res.headers.get("content-type") ?? "(none)"
    console.log(`  → status: ${res.status} ${res.statusText}`)
    console.log(`  → content-type: ${contentType}`)
    const body = await res.text()
    console.log(`  → body (first 500 chars):`)
    console.log(body.slice(0, 500))

    if (!res.ok) {
      console.log("  ⛔ status not OK → resolver returns null")
      return
    }
    if (!contentType.includes("json") && !contentType.includes("text/plain")) {
      console.log(
        "  ⛔ content-type is not JSON/text-plain → resolver returns null",
      )
      return
    }
    try {
      const parsed = JSON.parse(body)
      console.log(`  ✅ parsed metadata. name=${JSON.stringify(parsed.name)}, image=${JSON.stringify(parsed.image)}`)
    } catch (e) {
      console.log(`  ⛔ JSON.parse failed: ${shortErr(e)}`)
    }
  } catch (e) {
    console.log(`  ⛔ fetch threw: ${shortErr(e)}`)
  }
}

function shortErr(e) {
  const s = String(e?.shortMessage ?? e?.message ?? e)
  return s.length > 200 ? s.slice(0, 200) + "…" : s
}

const targets = []
if (rpcFlag) {
  targets.push(["custom --rpc", rpcFlag])
} else {
  if (env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL) {
    targets.push(["configured RPC (.env.local)", env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL])
  }
  if (env.ALCHEMY_API_KEY) {
    targets.push([
      "Alchemy mainnet",
      `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`,
    ])
  }
  if (targets.length === 0) {
    targets.push(["public llama RPC", "https://eth.llamarpc.com"])
  }
}

console.log(`Probing contract=${contract} tokenId=${tokenId}`)
for (const [label, url] of targets) {
  await probeRpc(label, url)
}
