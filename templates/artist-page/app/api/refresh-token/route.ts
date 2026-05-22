/**
 * Public, rate-limited single-token metadata refresh — backs the "Refresh
 * metadata" button on the auction page. Unlike `/api/revalidate` (owner-only,
 * secret-gated, can refresh the whole site), this only ever invalidates ONE
 * token's metadata, so the blast radius is tiny and it's safe to expose.
 *
 * Why this is cheap even without a secret: `revalidateTag` only *marks* the
 * cache entry stale — the actual on-chain + gateway re-fetch happens once, on
 * the next render, regardless of how many times it's triggered. The rate
 * limits below mainly protect serverless-function invocations and give the
 * button sane UX.
 *
 * Rate limiting is best-effort and in-memory (per warm function instance) to
 * keep the template dependency-free. That's plenty for a personal artist page;
 * a high-traffic deploy that wants hard guarantees would back this with a
 * shared store (Vercel KV / Upstash / Netlify Blobs).
 */
import { NextResponse } from "next/server"
import { revalidatePath, revalidateTag } from "next/cache"
import { isAddress } from "viem"
import { tokenMetadataTag } from "@/lib/metadata"

export const dynamic = "force-dynamic"

// One refresh per token per 30s, and a per-IP burst cap as defense-in-depth.
const TOKEN_COOLDOWN_MS = 30_000
const IP_WINDOW_MS = 60_000
const IP_MAX_IN_WINDOW = 12

const tokenLastRefresh = new Map<string, number>()
const ipHits = new Map<string, number[]>()

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for")
  return (
    xff?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  )
}

export async function POST(request: Request) {
  let body: { contract?: unknown; tokenId?: unknown; auctionId?: unknown }
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const contract = typeof body.contract === "string" ? body.contract : ""
  const tokenId =
    body.tokenId === undefined || body.tokenId === null
      ? ""
      : String(body.tokenId)
  const auctionId =
    body.auctionId === undefined || body.auctionId === null
      ? null
      : String(body.auctionId)

  if (!isAddress(contract) || tokenId === "") {
    return NextResponse.json(
      { ok: false, error: "invalid token" },
      { status: 400 },
    )
  }

  const now = Date.now()

  // Per-IP burst limit.
  const ip = clientIp(request)
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS)
  if (recent.length >= IP_MAX_IN_WINDOW) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. Slow down a moment." },
      { status: 429, headers: { "Retry-After": "60" } },
    )
  }
  recent.push(now)
  ipHits.set(ip, recent)

  // Per-token cooldown.
  const key = `${contract.toLowerCase()}:${tokenId}`
  const last = tokenLastRefresh.get(key) ?? 0
  const elapsed = now - last
  if (elapsed < TOKEN_COOLDOWN_MS) {
    const wait = Math.ceil((TOKEN_COOLDOWN_MS - elapsed) / 1000)
    return NextResponse.json(
      { ok: false, error: `Just refreshed — try again in ${wait}s.` },
      { status: 429, headers: { "Retry-After": String(wait) } },
    )
  }
  tokenLastRefresh.set(key, now)

  // Bound memory: drop stale entries occasionally.
  if (tokenLastRefresh.size > 1000) {
    for (const [k, t] of tokenLastRefresh) {
      if (now - t > TOKEN_COOLDOWN_MS) tokenLastRefresh.delete(k)
    }
  }
  if (ipHits.size > 5000) {
    for (const [k, ts] of ipHits) {
      if (ts.every((t) => now - t > IP_WINDOW_MS)) ipHits.delete(k)
    }
  }

  // Refresh just this token's metadata, and the page being viewed so the
  // change shows promptly. The home grid picks it up on its normal cycle.
  revalidateTag(tokenMetadataTag(contract, tokenId))
  if (auctionId && /^\d+$/.test(auctionId)) {
    revalidatePath(`/auction/${auctionId}`)
  }

  return NextResponse.json({ ok: true })
}
