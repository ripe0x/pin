#!/usr/bin/env node
// Full-history scan of Foundation NFTMarket cancellable listings, producing
// the seed data for public.fnd_cancellable_listings (the discovery side of
// /delist — see db/migrations/022_fnd_cancellable_listings.sql).
//
// Why this exists: the original seed's auction side came from the v1
// lazy-index snapshot (2026-05-03), which only saw auctions that PND
// page-views had triggered. Sellers who never entered PND's orbit (e.g. an
// FND collection whose artist isn't in known_artists) had live, cancellable
// reserve auctions the snapshot missed — a full scan found ~174k live
// auctions vs the snapshot's 13.5k.
//
// Pipeline:
//   1. One eth_getLogs sweep (market deploy → head) of ReserveAuction
//      Created/Finalized/Canceled/Invalidated + BuyPriceSet. Auction
//      candidates = created − closed; buy-now candidates = every
//      (contract, tokenId) that ever had a price set.
//   2. Union with any rows in the legacy JSON seed (if the file still
//      exists) — protects against pre-2021 event-signature drift.
//   3. Multicall3-verify every candidate against current chain state:
//      getReserveAuction / getBuyPrice are ground truth for liveness,
//      seller, and price (event-derived values can be stale). Bid-bearing
//      auctions are dropped — they can't be canceled and finalize within
//      24h of the bid.
//   4. Emit /tmp/fnd-cancellable-listings.csv for psql \copy.
//
// Usage:
//   ALCHEMY_API_KEY=... node scripts/scan-fnd-active-auctions.mjs [--dry-run]
//   psql "$DATABASE_URL" -c "\copy public.fnd_cancellable_listings FROM '/tmp/fnd-cancellable-listings.csv' CSV"
//
// RPC: Alchemy when ALCHEMY_API_KEY is set (one-time backfill, ~30k CU ≈
// pennies — same precedent as the BuyPriceSet scan that seeded buy-nows),
// else free public endpoints (slower; they throttle hard on big getLogs).

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const NFT_MARKET = "0xcda72070e455bb31c7690a170224ce43623d0b6f"
// Foundation launched 2021-02; block 11.5M (2021-01) is a safe lower bound.
const START_BLOCK = 11_500_000

const TOPIC_CREATED =
  "0x1062dd3b35f12b4064331244d00f40c1d4831965e4285654157a2409c6217cff"
const TOPIC_FINALIZED =
  "0x2edb0e99c6ac35be6731dab554c1d1fa1b7beb675090dbb09fb14e615aca1c4a"
const TOPIC_CANCELED =
  "0x14b9c40404d5b41deb481f9a40b8aeb2bf4b47679b38cf757075a66ed510f7f1"
const TOPIC_INVALIDATED =
  "0x5603897cc9b1e866f3f7395ffc6638776041f21c094d0b4e748ff44c407fa362"
const TOPIC_BUY_PRICE_SET =
  "0xfcc77ea8bdcce862f43b7fb00fe6b0eb90d6aeead27d3800d9257cf7a05f9d96"

const RPCS = process.env.ALCHEMY_API_KEY
  ? [`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`]
  : ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]
let rpcIndex = 0

// Response-too-big errors mean "shrink the block range"; everything else
// (429s, timeouts, 5xx) is transient and must NOT shrink the chunk —
// conflating the two pinned an earlier run at the floor for half an hour
// ("rate limit" matched a /limit/ regex meant for range limits).
const isRangeError = (err) =>
  /more than 10000|response size|block range|larger than|too large|query timeout/i.test(
    String(err?.message ?? err),
  )

const legacyJsonPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/web/src/data/fnd-cancellable.json",
)
// Listings only visible via pre-2021-signature events (the sweep can't see
// them). Written when the legacy JSON is present; read as extra candidates
// on every run so regens stay complete after the legacy JSON is gone.
// Candidates, not truths — verification prunes dead rows each run.
const driftGuardPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "data/fnd-legacy-listings.json",
)
const csvPath = "/tmp/fnd-cancellable-listings.csv"

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
      // range errors go straight to the caller, which shrinks the chunk
      if (isRangeError(err)) throw err
      if (attempt === 7) throw err
      // transient (429 / timeout / 5xx): back off, rotate if multi-provider
      rpcIndex++
      console.log(`  retry ${attempt + 1}: ${String(err.message ?? err).slice(0, 120)}`)
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

const hexAddr = (topic) => "0x" + topic.slice(26)
const dataWord = (data, i) =>
  BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64))

// ── Event sweep ──────────────────────────────────────────────────────────

async function sweepMarketEvents() {
  const head = Number(await rpc("eth_blockNumber", []))
  console.log(`scanning blocks ${START_BLOCK}..${head}`)

  const created = new Map() // auctionId -> {seller, contract, tokenId, priceWei}
  const closed = new Set()
  const buyNowTokens = new Map() // "contract-tokenId" -> {contract, tokenId}

  let from = START_BLOCK
  let chunk = 60_000
  let requests = 0
  while (from <= head) {
    const to = Math.min(from + chunk - 1, head)
    let logs
    try {
      logs = await rpc("eth_getLogs", [
        {
          address: NFT_MARKET,
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
          topics: [
            [
              TOPIC_CREATED,
              TOPIC_FINALIZED,
              TOPIC_CANCELED,
              TOPIC_INVALIDATED,
              TOPIC_BUY_PRICE_SET,
            ],
          ],
        },
      ])
    } catch (err) {
      if (isRangeError(err) && chunk > 500) {
        chunk = Math.max(500, Math.floor(chunk / 2))
        continue
      }
      // transient retries exhausted (or range error at the floor): abort
      // loudly rather than spin — rerunning is cheap
      console.error(`fatal at block ${from}: ${err.message ?? err}`)
      process.exit(1)
    }
    requests++
    for (const log of logs) {
      const t0 = log.topics[0]
      if (t0 === TOPIC_CREATED) {
        const auctionId = dataWord(log.data, 3).toString()
        created.set(auctionId, {
          seller: hexAddr(log.topics[1]),
          contract: hexAddr(log.topics[2]),
          tokenId: BigInt(log.topics[3]).toString(),
          priceWei: dataWord(log.data, 2).toString(),
        })
      } else if (t0 === TOPIC_BUY_PRICE_SET) {
        const contract = hexAddr(log.topics[1])
        const tokenId = BigInt(log.topics[2]).toString()
        // candidates only — getBuyPrice is the ground truth for whether a
        // listing is still live and who the seller is
        buyNowTokens.set(`${contract}-${tokenId}`, { contract, tokenId })
      } else {
        closed.add(BigInt(log.topics[1]).toString())
      }
    }
    if (requests % 25 === 0)
      console.log(
        `  block ${to} | chunk ${chunk} | created ${created.size} | closed ${closed.size} | buyNowTokens ${buyNowTokens.size} | req ${requests}`,
      )
    from = to + 1
    // grow back after shrinking through a hot range
    if (logs.length < 5_000) chunk = Math.min(200_000, Math.ceil(chunk * 1.5))
    await new Promise((r) => setTimeout(r, RPCS.length === 1 ? 100 : 250))
  }
  console.log(
    `sweep done: ${requests} requests | created ${created.size} | closed ${closed.size} | buyNowTokens ${buyNowTokens.size}`,
  )
  return { created, closed, buyNowTokens }
}

// ── On-chain verification via Multicall3.aggregate3 ─────────────────────
// Event arithmetic can miss closure paths that aren't in our topic set
// (e.g. admin cancels on older market versions). The market's view
// functions are ground truth: closed auctions / unset buy-nows return
// zero-filled structs.

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"
const SEL_AGGREGATE3 = "82ad56cb"
const SEL_GET_RESERVE_AUCTION = "9e79b41f" // getReserveAuction(uint256)
const SEL_GET_BUY_PRICE = "4635256e" // getBuyPrice(address,uint256)

const word = (v) => BigInt(v).toString(16).padStart(64, "0")

// calls: array of selector+args hex strings (no 0x prefix)
function encodeAggregate3(calls) {
  const heads = []
  let out = ""
  let offset = calls.length * 32
  for (const callData of calls) {
    heads.push(word(offset))
    const lenBytes = callData.length / 2
    const padded = callData.padEnd(Math.ceil(lenBytes / 32) * 64, "0")
    const elem =
      word(BigInt(NFT_MARKET)) + // target
      word(1) + // allowFailure
      word(0x60) + // offset to bytes within the struct
      word(lenBytes) +
      padded
    out += elem
    offset += elem.length / 2
  }
  return "0x" + SEL_AGGREGATE3 + word(0x20) + word(calls.length) + heads.join("") + out
}

// Returns per-call word-reader fns (null for failed/empty calls).
async function multicall(calls) {
  const ret = await rpc("eth_call", [
    { to: MULTICALL3, data: encodeAggregate3(calls) },
    "latest",
  ])
  const hex = ret.slice(2)
  const w = (j) => hex.slice(j * 64, (j + 1) * 64)
  const n = Number(BigInt("0x" + w(1)))
  if (n !== calls.length)
    throw new Error(`multicall decode: ${n} != ${calls.length}`)
  return Array.from({ length: n }, (_, j) => {
    const base = 2 + Number(BigInt("0x" + w(2 + j))) / 32
    const success = BigInt("0x" + w(base)) === 1n
    const len = success ? Number(BigInt("0x" + w(base + 2))) : 0
    if (!success || len === 0) return null
    return (field) => w(base + 3 + field)
  })
}

const BATCH = 500

async function verifyAuctions(candidates) {
  const verified = []
  let dropped = 0
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH)
    const results = await multicall(
      slice.map(([id]) => SEL_GET_RESERVE_AUCTION + word(BigInt(id))),
    )
    for (let j = 0; j < slice.length; j++) {
      const r = results[j]
      // struct: nftContract, tokenId, seller, duration, extDuration,
      //         endTime, bidder, amount
      if (!r) { dropped++; continue }
      const seller = "0x" + r(2).slice(24)
      const bidder = BigInt("0x" + r(6))
      const amount = BigInt("0x" + r(7))
      const [id, a] = slice[j]
      // keep live (zeroed struct → seller 0) and bid-free (a bid auction
      // can't be canceled and finalizes within 24h). The CHAIN's seller and
      // reserve are authoritative — event-derived sellers can go stale via
      // admin migrations, and ReserveAuctionUpdated changes the reserve.
      if (BigInt(seller) === 0n || bidder !== 0n) { dropped++; continue }
      verified.push([id, { ...a, seller, priceWei: amount.toString() }])
    }
    if ((i / BATCH) % 40 === 0)
      console.log(`  verify auctions ${Math.min(i + BATCH, candidates.length)}/${candidates.length}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`auctions verified: kept ${verified.length} | dropped ${dropped}`)
  return verified
}

async function verifyBuyNows(candidates) {
  const verified = []
  let dropped = 0
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH)
    const results = await multicall(
      slice.map(
        (b) =>
          SEL_GET_BUY_PRICE +
          word(BigInt(b.contract)) +
          word(BigInt(b.tokenId)),
      ),
    )
    for (let j = 0; j < slice.length; j++) {
      const r = results[j]
      if (!r) { dropped++; continue }
      const seller = "0x" + r(0).slice(24)
      const price = BigInt("0x" + r(1))
      // zeroed seller → no live buy-now for this token; otherwise the
      // chain's (seller, price) is authoritative
      if (BigInt(seller) === 0n) { dropped++; continue }
      verified.push({ ...slice[j], seller, priceWei: price.toString() })
    }
    if ((i / BATCH) % 40 === 0)
      console.log(`  verify buy-nows ${Math.min(i + BATCH, candidates.length)}/${candidates.length}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`buy-nows verified: kept ${verified.length} | dropped ${dropped}`)
  return verified
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes("--dry-run")

  const { created, closed, buyNowTokens } = await sweepMarketEvents()
  const auctionCandidates = new Map(
    [...created.entries()].filter(([id]) => !closed.has(id)),
  )

  // Drift-guard: candidates only visible via pre-2021 event signatures.
  // Sourced from the legacy bundled-JSON seed while it exists (and written
  // back to the small sidecar file for future runs); from the sidecar
  // afterwards. The sweep is the primary source; these are extra
  // candidates that verification prunes like any others.
  const guardAuctions = new Map() // auctionId -> {seller, contract, tokenId, priceWei}
  const guardBuyNows = new Map() // key -> {contract, tokenId}
  if (existsSync(legacyJsonPath)) {
    const legacy = JSON.parse(readFileSync(legacyJsonPath, "utf8"))
    for (const [seller, entry] of Object.entries(legacy)) {
      for (const a of entry.auctions) {
        if (auctionCandidates.has(a.auctionId)) continue
        guardAuctions.set(a.auctionId, {
          seller,
          contract: a.contract.toLowerCase(),
          tokenId: a.tokenId,
          priceWei: a.reserveWei,
        })
      }
      for (const b of entry.buyNows) {
        const key = `${b.contract.toLowerCase()}-${b.tokenId}`
        if (buyNowTokens.has(key)) continue
        guardBuyNows.set(key, {
          contract: b.contract.toLowerCase(),
          tokenId: b.tokenId,
        })
      }
    }
    console.log(
      `legacy JSON: +${guardAuctions.size} auctions, +${guardBuyNows.size} buy-now tokens not seen by the sweep`,
    )
    if (!process.argv.includes("--dry-run")) {
      writeFileSync(
        driftGuardPath,
        JSON.stringify({
          auctions: [...guardAuctions.entries()].map(([auctionId, a]) => ({
            auctionId,
            ...a,
          })),
          buyNows: [...guardBuyNows.values()],
        }),
      )
      console.log(`wrote drift-guard sidecar: ${driftGuardPath}`)
    }
  } else if (existsSync(driftGuardPath)) {
    const guard = JSON.parse(readFileSync(driftGuardPath, "utf8"))
    for (const { auctionId, ...a } of guard.auctions) {
      if (!auctionCandidates.has(auctionId)) guardAuctions.set(auctionId, a)
    }
    for (const b of guard.buyNows) {
      const key = `${b.contract}-${b.tokenId}`
      if (!buyNowTokens.has(key)) guardBuyNows.set(key, b)
    }
    console.log(
      `drift-guard sidecar: +${guardAuctions.size} auctions, +${guardBuyNows.size} buy-now tokens`,
    )
  }
  for (const [id, a] of guardAuctions) auctionCandidates.set(id, a)
  for (const [key, b] of guardBuyNows) buyNowTokens.set(key, b)

  const auctions = await verifyAuctions([...auctionCandidates.entries()])
  const buyNows = await verifyBuyNows([...buyNowTokens.values()])

  const sellers = new Set([
    ...auctions.map(([, a]) => a.seller),
    ...buyNows.map((b) => b.seller),
  ])
  console.log(
    `result: ${auctions.length} auctions + ${buyNows.length} buy-nows across ${sellers.size} sellers`,
  )
  if (dryRun) {
    console.log("dry-run: not writing CSV")
    return
  }

  const lines = [
    ...auctions.map(
      ([id, a]) => `a:${id},${a.seller},auction,${id},${a.contract},${a.tokenId},${a.priceWei}`,
    ),
    ...buyNows.map(
      (b) => `b:${b.contract}-${b.tokenId},${b.seller},buyNow,,${b.contract},${b.tokenId},${b.priceWei}`,
    ),
  ]
  writeFileSync(csvPath, lines.join("\n") + "\n")
  console.log(`wrote ${lines.length} rows to ${csvPath}`)
  console.log(
    `load with:\n  psql "$DATABASE_URL" -c "TRUNCATE public.fnd_cancellable_listings" -c "\\copy public.fnd_cancellable_listings FROM '${csvPath}' CSV"`,
  )
}

main()
