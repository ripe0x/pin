/**
 * Capture static media for PND Collection System tokens
 * (contracts/src/collection/), v1 scope = SVG only.
 *
 * Deploy-gated: no-op (zero counts) until SOVEREIGN_COLLECTION_FACTORY
 * resolves to a real address. `@pin/addresses` carries a zero-address
 * sentinel for it until mainnet deploy (same sentinel the indexer's
 * ponder.config.ts and the web app's collection-onchain.ts gate on via
 * `getAddressOrNull`) — this task uses the identical helper so all three
 * consumers flip on together at deploy, from one edit.
 *
 * Indexer-readiness gated, separately: the source of "which tokens need
 * a capture" is `${INDEXER_SCHEMA}.collection_tokens` (+ `.collections`),
 * written by a concurrent Ponder task for the SovereignCollectionFactory
 * discovery indexing (see docs/pnd-collection-web-plan.md D7). Those
 * tables don't exist yet on this branch — probed via information_schema,
 * same pattern as warm-metadata's ponderReady probe — so until they
 * land this task is *also* a no-op even once the factory address is set.
 *
 * Work loop (once both gates pass):
 *   1. Select tokens without a `collection_media` row (or a stale
 *      'failed' one past RETRY_AFTER).
 *   2. Read `tokenURI(tokenId)` on the collection contract (throttled).
 *   3. Parse the `data:application/json` (base64 or utf8) response.
 *   4. If `image` is an inline `data:image/svg+xml` URI: rasterize to a
 *      1200px PNG with sharp, store bytes in `collection_media`
 *      (status='ready').
 *   5. Else if the token's canonical view is `animation_url` HTML and
 *      there's no SVG `image` fallback: write a placeholder row
 *      (status='needs_html_capture') so we don't re-attempt every tick.
 *      The actual headless-capture path is a stub behind CAPTURE_HTML=1
 *      that only logs — no browser dependency added (open infra
 *      decision; see docs/pnd-collection-web-plan.md D7).
 *   6. Anything else (no image, no animation_url, bad data URI, sharp
 *      failure): status='failed', retried after RETRY_AFTER.
 */
import sharp from "sharp"
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import { sovereignCollectionAbi } from "@pin/abi"
import { SOVEREIGN_COLLECTION_FACTORY, MAINNET_CHAIN_ID, getAddressOrNull } from "@pin/addresses"
import { decodeFunctionResult, encodeFunctionData } from "viem"
import type { Address } from "viem"
import type { TaskResult } from "../scheduler.ts"

const TASK = "capture-collection-media"
const RASTER_WIDTH = 1200
const BATCH_SIZE = Number(process.env.CAPTURE_BATCH_SIZE ?? "20")
const RETRY_AFTER = process.env.CAPTURE_RETRY_AFTER ?? "1 day"
const CAPTURE_HTML = process.env.CAPTURE_HTML === "1"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

// Deploy-gated sentinel, identical helper to ponder.config.ts and
// apps/web/src/lib/collection-onchain.ts — flips on together at deploy.
const FACTORY = getAddressOrNull(SOVEREIGN_COLLECTION_FACTORY, MAINNET_CHAIN_ID)

type Candidate = { collection: string; tokenId: string }

/** `collection_tokens` (+ `collections`) exist only once the concurrent
 * Ponder discovery task has landed and run its migration. Probe rather
 * than assume, same as warm-metadata's ponderReady check — lets this
 * task come alive automatically the moment the tables appear, with no
 * follow-up deploy step of its own. */
async function collectionTablesReady(): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${INDEXER_SCHEMA} AND table_name = 'collection_tokens'
      ) AS ready
    `) as Array<{ ready: boolean }>
    return rows[0]?.ready === true
  } catch {
    return false
  }
}

async function findCandidates(): Promise<Candidate[]> {
  // Tokens with no capture row yet, or a 'failed' row old enough to retry.
  // needs_html_capture rows are NOT retried here — they're intentionally
  // parked until the headless path exists (CAPTURE_HTML path below only
  // logs; it doesn't clear the status).
  const rows = (await sql.unsafe(
    `SELECT lower(ct.collection) AS collection, ct.token_id::text AS "tokenId"
     FROM ${INDEXER_SCHEMA}.collection_tokens ct
     LEFT JOIN collection_media m
       ON m.collection = lower(ct.collection) AND m.token_id = ct.token_id::text
     WHERE m.collection IS NULL
        OR (m.status = 'failed' AND m.captured_at < NOW() - INTERVAL '${RETRY_AFTER.replace(/'/g, "''")}')
     LIMIT ${BATCH_SIZE}`,
  )) as Array<Candidate>
  return rows
}

/**
 * Parse a `data:application/json` tokenURI response (base64 or utf8,
 * mirrors @pin/token-metadata's parseDataUriJson) into a loose metadata
 * shape. Only `image` / `animation_url` matter for capture routing.
 */
function parseTokenJson(uri: string): { image?: string; animation_url?: string } | null {
  if (!uri.startsWith("data:")) return null
  const comma = uri.indexOf(",")
  if (comma < 0) return null
  const meta = uri.slice(5, comma)
  const body = uri.slice(comma + 1)
  const isBase64 = /;\s*base64\b/i.test(meta)
  try {
    const decoded = isBase64
      ? Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body)
    return JSON.parse(decoded)
  } catch {
    if (!isBase64) {
      try {
        return JSON.parse(body)
      } catch {
        return null
      }
    }
    return null
  }
}

/** Decode an inline `data:image/svg+xml` URI (base64 or utf8) to raw SVG
 * markup, or null if `imageUri` isn't that scheme. */
function decodeInlineSvg(imageUri: string): string | null {
  if (!imageUri.startsWith("data:image/svg+xml")) return null
  const comma = imageUri.indexOf(",")
  if (comma < 0) return null
  const meta = imageUri.slice(5, comma)
  const body = imageUri.slice(comma + 1)
  const isBase64 = /;\s*base64\b/i.test(meta)
  try {
    return isBase64 ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body)
  } catch {
    return null
  }
}

async function upsertMedia(
  collection: string,
  tokenId: string,
  fields: { kind: string; status: string; png?: Buffer; width?: number; error?: string },
): Promise<void> {
  await sql`
    INSERT INTO collection_media
      (collection, token_id, kind, status, png, width, error, captured_at)
    VALUES
      (${collection}, ${tokenId}, ${fields.kind}, ${fields.status},
       ${fields.png ?? null}, ${fields.width ?? null}, ${fields.error ?? null}, NOW())
    ON CONFLICT (collection, token_id) DO UPDATE SET
      kind = EXCLUDED.kind, status = EXCLUDED.status, png = EXCLUDED.png,
      width = EXCLUDED.width, error = EXCLUDED.error, captured_at = NOW()
  `
}

async function captureOne(c: Candidate): Promise<{ rpc: number; wrote: boolean }> {
  let rpc = 0
  let tokenUri: string
  try {
    await throttleRpc()
    // Explicit gas ceiling: onchain-HTML tokenURIs (GenerativeRenderer over
    // gzipped libs) measure 60-120M gas, beyond the default eth_call cap.
    const uriCall = await client.call({
      to: c.collection as Address,
      data: encodeFunctionData({
        abi: sovereignCollectionAbi,
        functionName: "tokenURI",
        args: [BigInt(c.tokenId)],
      }),
      gas: 300_000_000n,
    })
    if (!uriCall.data) throw new Error("empty tokenURI return")
    tokenUri = decodeFunctionResult({
      abi: sovereignCollectionAbi,
      functionName: "tokenURI",
      data: uriCall.data,
    }) as string
    rpc += 1
  } catch (err) {
    console.error(`[${TASK}] tokenURI ${c.collection}/${c.tokenId}:`, err)
    await upsertMedia(c.collection, c.tokenId, {
      kind: "svg",
      status: "failed",
      error: `tokenURI read failed: ${(err as Error).message}`,
    })
    return { rpc, wrote: true }
  }

  const meta = parseTokenJson(tokenUri)
  if (!meta) {
    await upsertMedia(c.collection, c.tokenId, {
      kind: "svg",
      status: "failed",
      error: "tokenURI did not resolve to parseable inline JSON",
    })
    return { rpc, wrote: true }
  }

  const svgMarkup = meta.image ? decodeInlineSvg(meta.image) : null
  if (svgMarkup) {
    try {
      const png = await sharp(Buffer.from(svgMarkup)).resize({ width: RASTER_WIDTH }).png().toBuffer()
      await upsertMedia(c.collection, c.tokenId, {
        kind: "svg",
        status: "ready",
        png,
        width: RASTER_WIDTH,
      })
      return { rpc, wrote: true }
    } catch (err) {
      console.error(`[${TASK}] rasterize ${c.collection}/${c.tokenId}:`, err)
      await upsertMedia(c.collection, c.tokenId, {
        kind: "svg",
        status: "failed",
        error: `sharp rasterize failed: ${(err as Error).message}`,
      })
      return { rpc, wrote: true }
    }
  }

  if (meta.animation_url) {
    // Canonical view is HTML with no SVG fallback. Headless capture is an
    // open infra decision (no puppeteer/playwright in the worker image) —
    // see docs/pnd-collection-web-plan.md D7. Park the row so we don't
    // re-attempt every tick; CAPTURE_HTML=1 only logs the intent, it does
    // not actually render anything.
    if (CAPTURE_HTML) {
      console.log(
        `[${TASK}] CAPTURE_HTML=1 set but no headless browser is wired in — ` +
          `skipping HTML capture for ${c.collection}/${c.tokenId} (animation_url present, no SVG image)`,
      )
    }
    await upsertMedia(c.collection, c.tokenId, { kind: "html", status: "needs_html_capture" })
    return { rpc, wrote: true }
  }

  await upsertMedia(c.collection, c.tokenId, {
    kind: "svg",
    status: "failed",
    error: "no image (SVG) or animation_url in token metadata",
  })
  return { rpc, wrote: true }
}

export async function captureCollectionMedia(): Promise<TaskResult> {
  // Gate 1: contracts not deployed yet (zero-address sentinel).
  if (!FACTORY) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  // Gate 2: discovery indexing (concurrent Ponder work) hasn't landed /
  // hasn't backfilled yet.
  if (!(await collectionTablesReady())) {
    return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  }

  const candidates = await findCandidates()
  if (candidates.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  let rpcCalls = 0
  let rowsWritten = 0
  for (const c of candidates) {
    const { rpc, wrote } = await captureOne(c).catch((err) => {
      console.error(`[${TASK}] unexpected failure ${c.collection}/${c.tokenId}:`, err)
      return { rpc: 0, wrote: false }
    })
    rpcCalls += rpc
    if (wrote) rowsWritten += 1
  }

  return { scopeCount: candidates.length, rpcCalls, rowsWritten }
}
