import "server-only"
import type { Address } from "viem"
import { sql } from "../db"
import type { ImportSource, RawWork, SkippedWork } from "./types.ts"

/**
 * Adapter that pre-populates the Catalog import planner from our own
 * indexed data — `artist_tokens` (worker-owned: fnd-collection, mint,
 * tl, manifold) UNION the Ponder-owned shared-platform tables
 * (`fnd_artist_tokens`, `srv2_artist_tokens`). Joined with
 * `token_metadata` for titles + image URLs.
 *
 * This source is artist-agnostic — every artist with any indexed
 * tokens gets a one-click prefill, no per-artist adapter required.
 * Brinkman keeps his bespoke registry adapter; this one covers
 * everyone else and complements his for the platform-side tokens.
 *
 * All indexed platforms are mainnet-only, so chainId is hardcoded to 1.
 * Shared-platform contracts (FND shared 1/1, SR V2 shared) are emitted
 * as individual tokens here — `shared-contracts.ts` filtering in the
 * planner UI keeps the artist from claiming whole shared contracts.
 *
 * Catalog dedup happens downstream in `normalize.ts` against the
 * on-chain Catalog snapshot, so we don't pre-filter already-declared
 * tokens; sending them through normalize keeps the source-of-truth
 * single and gives the artist an honest "already in catalog" count.
 */

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g,
  "",
)

type Row = {
  contract: string
  token_id: string
  platform: string
  name: string | null
  image_url: string | null
  raw_uri: string | null
  collection_name: string | null
}

/**
 * Platforms where the artist deployed (or owns) the underlying contract.
 * For these, "this whole contract is mine" is the right default for
 * Catalog import: one `addContract` write, claims all current + future
 * tokens.
 *
 * Excluded: 'fnd-shared' + 'srv2-shared' — those are platform-wide
 * contracts where many artists co-exist; the artist owns the TOKEN but
 * not the CONTRACT. Per-token addToken is the only safe op.
 */
const ARTIST_OWNED_PLATFORMS = new Set([
  "manifold",
  "mint",
  "fnd-collection",
  "tl",
])

export function pndIndexedSource(artist: Address): ImportSource {
  const lower = artist.toLowerCase() as Address
  return {
    id: "pnd-indexed",
    artistAddress: lower,
    displayName: "Indexed by pnd",
    sourceUrl: `/artist/${lower}`,
    fetchWorks: () => fetchPndIndexedWorks(lower),
  }
}

async function fetchPndIndexedWorks(
  artist: Address,
): Promise<{ works: RawWork[]; skipped: SkippedWork[] }> {
  if (!sql) return { works: [], skipped: [] }
  const lower = artist.toLowerCase()

  // UNION the worker-owned artist_tokens with the two Ponder shared-
  // platform tables, then LEFT JOIN token_metadata for display fields
  // and manifold_contracts for the collection-level name (only present
  // for manifold-platform contracts; other artist-owned platforms
  // currently have no per-contract name source — adapter falls back to
  // contract_identity if available later, undefined for now).
  // Stable ORDER so the planner preview is deterministic between
  // reloads.
  const rows = (await sql.unsafe(
    `WITH src AS (
       SELECT lower(contract) AS contract, token_id, platform
       FROM artist_tokens WHERE artist = $1
       UNION ALL
       SELECT lower(contract), token_id::text, 'fnd-shared' AS platform
       FROM ${INDEXER_SCHEMA}.fnd_artist_tokens WHERE lower(creator) = $1
       UNION ALL
       SELECT lower(contract), token_id::text, 'srv2-shared' AS platform
       FROM ${INDEXER_SCHEMA}.srv2_artist_tokens WHERE lower(creator) = $1
     )
     SELECT src.contract, src.token_id, src.platform,
            m.name, m.image_url, m.raw_uri,
            COALESCE(mc.collection_name, ci.name) AS collection_name
     FROM src
     LEFT JOIN token_metadata m
       ON m.contract = src.contract AND m.token_id = src.token_id
     LEFT JOIN manifold_contracts mc
       ON mc.artist = $1 AND mc.contract = src.contract
     LEFT JOIN contract_identity ci
       ON ci.address = src.contract
     ORDER BY src.contract, src.token_id`,
    [lower],
  )) as Row[]

  const works: RawWork[] = rows.map((r) => {
    const tokenId = BigInt(r.token_id)
    const primary = r.image_url ?? undefined
    const rawUri = r.raw_uri ?? undefined
    // Fallback strategy: if primary is IPFS, swap gateway; otherwise
    // fall back to raw_uri (often the on-chain tokenURI itself, which
    // Thumb can resolve via the IPFS gateway / weserv proxy chain).
    const fallback =
      primary && isIpfsLike(primary)
        ? swapIpfsGateway(primary)
        : isIpfsLike(rawUri)
          ? toIpfsHttpUrl(rawUri)
          : rawUri
    return {
      id: `${r.contract}:${r.token_id}`,
      title: r.name && r.name.trim() ? r.name : `#${r.token_id}`,
      chainId: 1,
      contract: r.contract as Address,
      tokenId,
      imageUrl: primary,
      imageFallbackUrl: fallback,
      // Artist-owned platforms get the "claim whole contract" default.
      // Shared platforms stay per-token (artist owns the token, not the
      // contract). See ARTIST_OWNED_PLATFORMS above for the gate.
      claimWholeContract: ARTIST_OWNED_PLATFORMS.has(r.platform),
      collectionName:
        r.collection_name && r.collection_name.trim()
          ? r.collection_name
          : undefined,
    }
  })

  return { works, skipped: [] }
}

function isIpfsLike(v: string | undefined): v is string {
  if (!v) return false
  return v.startsWith("ipfs://") || v.includes("/ipfs/")
}

function toIpfsHttpUrl(v: string | undefined): string | undefined {
  if (!v) return undefined
  if (v.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${v.slice("ipfs://".length)}`
  }
  return v
}

/**
 * Swap an `https://<some-gateway>/ipfs/<cid>...` URL to ipfs.io.
 * Cloudflare / nftstorage / web3.storage etc. all rotate pins; sending
 * the secondary attempt to a different gateway gives us a meaningful
 * second chance rather than re-hitting the same dead host.
 */
function swapIpfsGateway(url: string): string {
  const idx = url.indexOf("/ipfs/")
  if (idx < 0) return url
  return `https://ipfs.io${url.slice(idx)}`
}
