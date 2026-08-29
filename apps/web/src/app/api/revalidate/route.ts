import { revalidateTag } from "next/cache"
import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { sql } from "@/lib/db"
import { pgCacheInvalidate } from "@/lib/pg-cache"

/**
 * Manually flush the artist gallery + enriched-page caches. Hit this after
 * minting a new token so the gallery picks it up immediately instead of
 * waiting for the 24h TTL.
 *
 * Authenticated POST only. Use this from CLI/automation without putting
 * secrets in URLs:
 *
 *       curl -X POST 'https://pnd.ripe.wtf/api/revalidate' \
 *         -H "Authorization: Bearer $REVALIDATE_SECRET"
 *
 * `artist-refs` and `artist-enriched` are global tags, so flushing
 * invalidates the caches for ALL artists, not just one. The optional
 * `artist` query param is informational (echoed in the response).
 * Repopulation is lazy (one cold gallery read per artist).
 *
 * Per-token unstick (authenticated only): pass `contract` + `tokenId` to
 * also delete that row from the persistent `token_metadata` index, so the
 * next page view re-resolves via RPC + IPFS. Use when a token got cached
 * as the all-null sentinel from a transient gateway failure on first view.
 *
 *   curl -X POST 'https://pnd.ripe.wtf/api/revalidate?contract=0x…&tokenId=88' \
 *     -H "Authorization: Bearer $REVALIDATE_SECRET"
 */

export async function GET() {
  return NextResponse.json(
    { ok: false, error: "method not allowed" },
    { status: 405, headers: { Allow: "POST" } },
  )
}

export async function POST(req: NextRequest) {
  const expected = process.env.REVALIDATE_SECRET
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "REVALIDATE_SECRET env var not set on server" },
      { status: 500 },
    )
  }
  const authorization = req.headers.get("authorization")
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : ""
  if (!secretMatches(provided, expected)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    )
  }
  return handleRevalidation(req)
}

async function handleRevalidation(req: NextRequest) {
  const artist = req.nextUrl.searchParams.get("artist")
  const contract = req.nextUrl.searchParams.get("contract")
  const tokenId = req.nextUrl.searchParams.get("tokenId")

  // Per-token unstick (authenticated only). The persistent `token_metadata`
  // table is treated as immutable once written, so a row written from a
  // failed first-fetch (transient gateway flake) gets stuck as an all-null
  // sentinel until the warmer's 7-day retry. This deletes that row so the
  // next page view re-resolves via RPC + IPFS. Tag invalidation alone is
  // not enough — the L1 unstable_cache reads from the DB row.
  let tokenMetadataDeleted = false
  if (contract && tokenId) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
      return NextResponse.json(
        { ok: false, error: "invalid contract address" },
        { status: 400 },
      )
    }
    if (sql) {
      const rows = await sql`
        DELETE FROM token_metadata
        WHERE contract = ${contract.toLowerCase()} AND token_id = ${tokenId}
      `
      tokenMetadataDeleted = rows.count > 0
    }
  }

  revalidateTag("artist-refs")
  revalidateTag("artist-enriched")
  revalidateTag("token-metadata")
  revalidateTag("token-onchain-data")
  revalidateTag("erc1155-stats")
  revalidateTag("last-sale")
  revalidateTag("ens")

  // Also flush the L2 (Postgres) entries that back the same data — without
  // this, a fresh render after a Refresh click would still hit stale rows
  // in pgCache from any sandbox. ENS is included here (despite its 24h TTL
  // and global reuse) because the pgCache double-stringify bug corrupted
  // every L2 row written during its window, and ENS is the slowest of the
  // affected caches to self-heal. Re-resolution is lazy, so the cost is
  // bounded (one ENSIdeas lookup per address as it's next requested).
  await Promise.all([
    pgCacheInvalidate("token-onchain-data:"),
    pgCacheInvalidate("erc1155-stats:"),
    pgCacheInvalidate("token-metadata:"),
    pgCacheInvalidate("active-auction-count:"),
    pgCacheInvalidate("seller-listings:"),
    pgCacheInvalidate("auction:"),
    pgCacheInvalidate("last-sale:"),
    pgCacheInvalidate("ens:"),
  ])

  return NextResponse.json({
    ok: true,
    revalidated: ["artist-refs", "artist-enriched", "token-metadata", "token-onchain-data", "erc1155-stats", "last-sale", "ens"],
    pgCacheCleared: true,
    requested_for: artist ?? null,
    tokenMetadataDeleted:
      contract && tokenId
        ? { contract: contract.toLowerCase(), tokenId, deleted: tokenMetadataDeleted }
        : null,
    note: "All-artist flush; per-artist tagging requires dynamic tags (not supported by unstable_cache).",
  })
}

function secretMatches(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided)
  const expectedBytes = Buffer.from(expected)
  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  )
}
