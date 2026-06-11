#!/usr/bin/env node
// One-time full-history discovery sweep for the Foundation seeds
// (db/migrations/023_fnd_discovery_seeds.sql):
//
//   1. NFTCollectionCreated / legacy CollectionCreated on both FND
//      collection factories → public.fnd_collections_seed (which artist
//      deployed which 1/1 collection clone).
//   2. Minted on the FND shared 1/1 contract → public.fnd_shared_mints_seed
//      (which artist minted which shared-contract token).
//
// Ponder watches both live from FND_START_BLOCK (~Oct 2025); these seeds
// freeze everything before that. History is immutable, so this never
// needs to run again — rerunning is harmless (TRUNCATE + reload).
//
// Usage:
//   ALCHEMY_API_KEY=... node scripts/scan-fnd-discovery-seeds.mjs
//   psql "$DATABASE_URL" \
//     -c "TRUNCATE public.fnd_collections_seed" \
//     -c "\copy public.fnd_collections_seed FROM '/tmp/fnd-collections-seed.csv' CSV" \
//     -c "TRUNCATE public.fnd_shared_mints_seed" \
//     -c "\copy public.fnd_shared_mints_seed FROM '/tmp/fnd-shared-mints-seed.csv' CSV"
//
// RPC: ~150 getLogs on Alchemy one-time (same precedent as the
// fnd_cancellable_listings scan); free public endpoints as fallback.

import { writeFileSync } from "node:fs"

const FACTORY_V1 = "0x3b612a5b49e025a6e4ba4ee4fb1ef46d13588059"
const FACTORY_V2 = "0x612e2daddc89d91409e40f946f9f7cfe422e777e"
const SHARED_NFT = "0x3b3ee1931dc30c1957379fac9aba94d1c48a5405"
// Foundation launched 2021-02; block 11.5M (2021-01) is a safe floor.
const START_BLOCK = 11_500_000

const TOPIC_COLLECTION_CREATED_V2 =
  "0x22bd5d982c942d99c12bfa4feda7e796b2b9d6a1b8097c890871b12de29963eb" // NFTCollectionCreated
const TOPIC_COLLECTION_CREATED_LEGACY =
  "0xd3cbcb86b6ae20e08baf6a5fbaf0c922acff26cdc663bdf06744f5023bbcd254" // CollectionCreated (pre-rename V1)
const TOPIC_MINTED =
  "0xe2406cfd356cfbe4e42d452bde96d27f48c423e5f02b5d78695893308399519d"

const RPCS = process.env.ALCHEMY_API_KEY
  ? [`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`]
  : ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]
let rpcIndex = 0

const isRangeError = (err) =>
  /more than 10000|response size|block range|larger than|too large|query timeout/i.test(
    String(err?.message ?? err),
  )

let rpcId = 0
async function rpc(method, params) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = RPCS[rpcIndex % RPCS.length]
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = await res.json()
      if (body.error) throw new Error(body.error.message)
      return body.result
    } catch (err) {
      if (isRangeError(err)) throw err
      if (attempt === 7) throw err
      rpcIndex++
      console.log(`  retry ${attempt + 1}: ${String(err.message ?? err).slice(0, 120)}`)
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

const hexAddr = (topic) => "0x" + topic.slice(26)

/** Adaptive-chunk full-range getLogs sweep; onLog per matched log. */
async function sweep(label, filter, head, onLog) {
  let from = START_BLOCK
  let chunk = 200_000
  let requests = 0
  let matched = 0
  while (from <= head) {
    const to = Math.min(from + chunk - 1, head)
    let logs
    try {
      logs = await rpc("eth_getLogs", [
        {
          ...filter,
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
        },
      ])
    } catch (err) {
      if (isRangeError(err) && chunk > 500) {
        chunk = Math.max(500, Math.floor(chunk / 2))
        continue
      }
      console.error(`fatal at block ${from}: ${err.message ?? err}`)
      process.exit(1)
    }
    requests++
    for (const log of logs) onLog(log)
    matched += logs.length
    if (requests % 25 === 0)
      console.log(`  [${label}] block ${to} | chunk ${chunk} | matched ${matched} | req ${requests}`)
    from = to + 1
    if (logs.length < 5_000) chunk = Math.min(400_000, Math.ceil(chunk * 1.5))
    await new Promise((r) => setTimeout(r, RPCS.length === 1 ? 100 : 250))
  }
  console.log(`[${label}] done: ${requests} requests, ${matched} events`)
}

async function main() {
  const head = Number(await rpc("eth_blockNumber", []))
  console.log(`sweeping blocks ${START_BLOCK}..${head}`)

  // ── 1. Collection factory deploys ─────────────────────────────────────
  const collections = new Map() // collection -> {creator, block, tx}
  await sweep(
    "factories",
    {
      address: [FACTORY_V1, FACTORY_V2],
      topics: [[TOPIC_COLLECTION_CREATED_V2, TOPIC_COLLECTION_CREATED_LEGACY]],
    },
    head,
    (log) => {
      collections.set(hexAddr(log.topics[1]), {
        creator: hexAddr(log.topics[2]),
        block: Number(BigInt(log.blockNumber)),
        tx: log.transactionHash,
      })
    },
  )

  // ── 2. Shared-contract mints ──────────────────────────────────────────
  const mints = new Map() // tokenId -> {creator, block, logIndex, tx}
  await sweep(
    "shared-mints",
    { address: SHARED_NFT, topics: [TOPIC_MINTED] },
    head,
    (log) => {
      mints.set(BigInt(log.topics[2]).toString(), {
        creator: hexAddr(log.topics[1]),
        block: Number(BigInt(log.blockNumber)),
        logIndex: Number(BigInt(log.logIndex)),
        tx: log.transactionHash,
      })
    },
  )

  const collectionsCsv = [...collections.entries()]
    .map(([c, v]) => `${c},${v.creator},${v.block},${v.tx}`)
    .join("\n")
  writeFileSync("/tmp/fnd-collections-seed.csv", collectionsCsv + "\n")

  const mintsCsv = [...mints.entries()]
    .map(([id, v]) => `${id},${v.creator},${v.block},${v.logIndex},${v.tx}`)
    .join("\n")
  writeFileSync("/tmp/fnd-shared-mints-seed.csv", mintsCsv + "\n")

  const creators = new Set([...collections.values()].map((v) => v.creator))
  const minters = new Set([...mints.values()].map((v) => v.creator))
  console.log(
    `wrote ${collections.size} collections (${creators.size} creators) and ${mints.size} shared mints (${minters.size} minters)`,
  )
}

main()
