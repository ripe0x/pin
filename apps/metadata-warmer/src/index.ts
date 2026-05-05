/**
 * token_metadata pre-warmer.
 *
 * Long-lived sidecar to the Ponder indexer. On a slow loop it scans the
 * Ponder source tables for (contract, tokenId) pairs that haven't been
 * resolved yet, calls the same RPC + IPFS resolver the web app uses,
 * and upserts the results into `token_metadata`. After steady-state
 * operation every token visible in the web app is a Postgres point
 * lookup — no first-view RPC + IPFS cost.
 *
 * Architectural notes:
 *   - This is deliberately a separate process, NOT a Ponder event
 *     handler. IPFS gateways flake (502s, timeouts, stale pins);
 *     coupling indexer health to gateway availability would let
 *     Ponder fall behind chain head. The worker can fail and retry
 *     without affecting the indexer.
 *   - The web app's lazy resolver (`resolveTokenMetadataDirect`) stays
 *     in place as a defense-in-depth fallback. If the worker is down
 *     or behind, the first user to view a token still gets data;
 *     they just pay the latency the worker would have absorbed.
 *   - Re-resolves previously-failed rows on a slow cadence
 *     (`RETRY_AFTER`, default 7 days). IPFS pinning sometimes recovers,
 *     so a stale empty sentinel is worth retrying once a week.
 */
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { resolveTokenMetadata } from "@pin/token-metadata"
import { createServer } from "node:http"
import { findCandidates, sql, writeTokenMetadata } from "./db.ts"

const BATCH_SIZE = Number(process.env.WARMER_BATCH_SIZE ?? "50")
const TICK_INTERVAL_MS = Number(process.env.WARMER_TICK_MS ?? "30000")
const IDLE_INTERVAL_MS = Number(process.env.WARMER_IDLE_MS ?? "300000")
const CONCURRENCY = Number(process.env.WARMER_CONCURRENCY ?? "4")
const RETRY_AFTER = process.env.WARMER_RETRY_AFTER ?? "7 days"
const HEALTH_PORT = Number(process.env.PORT ?? "8080")

function getRpcUrl(): string {
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return explicit
  const key = process.env.ALCHEMY_API_KEY
  if (key) return `https://eth-mainnet.g.alchemy.com/v2/${key}`
  // eslint-disable-next-line no-console
  console.error(
    "[metadata-warmer] ALCHEMY_API_KEY / ALCHEMY_MAINNET_URL unset — exiting. tokenURI calls would throttle.",
  )
  process.exit(1)
}

const client = createPublicClient({
  chain: mainnet,
  transport: http(getRpcUrl(), { batch: true }),
})

let lastTickAt: Date | null = null
let lastTickResolved = 0
let lastTickFailed = 0
let totalResolved = 0
let totalFailed = 0
let shuttingDown = false

async function processCandidate(c: {
  contract: string
  tokenId: string
}): Promise<"resolved" | "empty"> {
  try {
    const meta = await resolveTokenMetadata(client, c.contract, c.tokenId)
    await writeTokenMetadata(c.contract, c.tokenId, {
      name: meta?.name ?? null,
      description: meta?.description ?? null,
      imageUrl: meta?.image ?? null,
    })
    return meta && (meta.name || meta.description || meta.image)
      ? "resolved"
      : "empty"
  } catch (err) {
    // Write the empty sentinel so we don't immediately re-attempt on
    // the next tick. Retry policy still kicks in after RETRY_AFTER.
    // eslint-disable-next-line no-console
    console.error(
      `[metadata-warmer] resolve threw for ${c.contract}/${c.tokenId}:`,
      err,
    )
    try {
      await writeTokenMetadata(c.contract, c.tokenId, {
        name: null,
        description: null,
        imageUrl: null,
      })
    } catch {
      // best effort
    }
    return "empty"
  }
}

async function tick(): Promise<number> {
  const candidates = await findCandidates(BATCH_SIZE, RETRY_AFTER)
  if (candidates.length === 0) return 0

  let resolved = 0
  let failed = 0

  // Process in bounded-concurrency chunks. RPC is happy to batch many
  // calls; IPFS gateways throttle quickly above ~5 concurrent fetches.
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const slice = candidates.slice(i, i + CONCURRENCY)
    const results = await Promise.all(slice.map(processCandidate))
    for (const r of results) {
      if (r === "resolved") resolved += 1
      else failed += 1
    }
  }

  lastTickResolved = resolved
  lastTickFailed = failed
  totalResolved += resolved
  totalFailed += failed
  return candidates.length
}

async function run(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    `[metadata-warmer] starting: batch=${BATCH_SIZE} concurrency=${CONCURRENCY} tick=${TICK_INTERVAL_MS}ms retry_after="${RETRY_AFTER}"`,
  )
  while (!shuttingDown) {
    let processed = 0
    try {
      processed = await tick()
      lastTickAt = new Date()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[metadata-warmer] tick failed:", err)
    }
    const sleepMs = processed === 0 ? IDLE_INTERVAL_MS : TICK_INTERVAL_MS
    await sleep(sleepMs)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    // Allow shutdown to interrupt the sleep promptly.
    t.unref()
  })
}

// ─── Healthcheck server ──────────────────────────────────────────────
// Railway's `healthcheckPath` polls a single endpoint; failures restart
// the service. We treat "loop has run at least once in the last 5×
// IDLE_INTERVAL_MS" as healthy — that includes long idle stretches when
// there's nothing to warm.

const health = createServer((req, res) => {
  if (req.url !== "/health") {
    res.statusCode = 404
    res.end()
    return
  }
  const now = Date.now()
  const since = lastTickAt ? now - lastTickAt.getTime() : Infinity
  const stale = since > IDLE_INTERVAL_MS * 5
  const body = {
    ok: !stale,
    lastTickAt: lastTickAt?.toISOString() ?? null,
    lastTickResolved,
    lastTickFailed,
    totalResolved,
    totalFailed,
  }
  res.statusCode = stale ? 503 : 200
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
})

health.listen(HEALTH_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[metadata-warmer] health server listening on :${HEALTH_PORT}`)
})

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    // eslint-disable-next-line no-console
    console.log(`[metadata-warmer] received ${sig}, shutting down`)
    shuttingDown = true
    health.close()
    try {
      await sql.end({ timeout: 5 })
    } catch {
      // ignore
    }
    process.exit(0)
  })
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[metadata-warmer] fatal:", err)
  process.exit(1)
})
