import "server-only"
import { sql } from "./db"
import type { TokenRef } from "./onchain-discovery"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g,
  "",
)

export const OBSERVED_SOURCE_FRESHNESS_MINUTES = 15

export type AvailabilityKind = "auction" | "buy-now"
export type AvailabilityStatus = "listed" | "active" | "settling" | "buy-now"
export type AvailabilitySource = "pnd" | "foundation" | "superrare" | "transient"

export type WorkAvailability = {
  kind: AvailabilityKind
  source: AvailabilitySource
  status: AvailabilityStatus
  seller: string
  price: string
  reservePrice: string | null
  currentBid: string | null
  endTime: string | null
  observedAt: string | null
  observedBlock: string | null
  freshness: "fresh" | "indexed"
  destination: string | null
  auctionId: string | null
}

export type AvailabilityCoverage = {
  indexedSources: string[]
  hiddenStaleSources: string[]
  note: string
}

export type RankedRefsPage = {
  refs: TokenRef[]
  availability: Map<string, WorkAvailability>
  total: number
  availableTotal: number
  coverage: AvailabilityCoverage
}

type RankedRow = {
  contract: string
  token_id: string
  creator: string
  collection_name: string | null
  platform: string
  mint_block: string
  kind: AvailabilityKind | null
  source: AvailabilitySource | null
  availability_status: AvailabilityStatus | null
  seller: string | null
  price: string | null
  reserve_price: string | null
  current_bid: string | null
  end_time: string | null
  observed_at: Date | string | null
  observed_block: string | null
  freshness: "fresh" | "indexed" | null
  destination: string | null
  auction_id: string | null
  total_count: number
  available_count: number
}

function uniqueRefs(refs: readonly TokenRef[]): TokenRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.contract.toLowerCase()}:${ref.tokenId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/**
 * Rank availability across the complete artist inventory before LIMIT/OFFSET.
 * The refs cache remains the discovery source, but sale state and pagination
 * are one Postgres query. No request-time RPC or page-local resorting.
 */
export async function rankArtistTokenRefs(
  artist: string,
  refsInput: readonly TokenRef[],
  page: number,
  pageSize: number,
): Promise<RankedRefsPage> {
  const refs = uniqueRefs(refsInput)
  const fallback: RankedRefsPage = {
    refs: refs.slice(page * pageSize, (page + 1) * pageSize),
    availability: new Map(),
    total: refs.length,
    availableTotal: 0,
    coverage: {
      indexedSources: ["Foundation", "Manifold", "Mint", "PND", "SuperRare", "Transient Labs"],
      hiddenStaleSources: [],
      note: "Availability is unavailable; works remain ordered by mint time.",
    },
  }
  if (!sql || refs.length === 0) return fallback

  const contracts = refs.map((r) => r.contract.toLowerCase())
  const tokenIds = refs.map((r) => r.tokenId)
  const creators = refs.map((r) => r.creator.toLowerCase())
  const collectionNames = refs.map((r) => r.collectionName)
  const platforms = refs.map((r) => r.platform)
  const mintBlocks = refs.map((r) => r.mintBlock ?? "0")
  const offset = page * pageSize

  let rows: RankedRow[]
  try {
    rows = (await sql.unsafe(
      `WITH refs AS (
       SELECT contract, token_id, creator, collection_name, platform,
              mint_block::bigint AS mint_block, ordinality
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         WITH ORDINALITY AS r(contract, token_id, creator, collection_name, platform, mint_block, ordinality)
     ),
     available AS (
       SELECT lower(token_contract) AS contract, token_id::text AS token_id,
              'auction'::text AS kind, 'pnd'::text AS source,
              CASE
                WHEN first_bid_time = 0 THEN 'listed'
                WHEN end_time > 0 AND end_time <= EXTRACT(EPOCH FROM NOW())::bigint THEN 'settling'
                ELSE 'active'
              END AS availability_status,
              lower(seller) AS seller,
              CASE WHEN first_bid_time = 0 THEN reserve_price ELSE amount END::text AS price,
              reserve_price::text AS reserve_price,
              CASE WHEN first_bid_time = 0 THEN NULL ELSE amount::text END AS current_bid,
              NULLIF(end_time, 0)::text AS end_time,
              to_timestamp(created_at_time) AS observed_at,
              created_at_block::text AS observed_block,
              'indexed'::text AS freshness,
              '/auction/' || lower(house) || '/' || auction_id::text AS destination,
              auction_id::text AS auction_id,
              CASE
                WHEN first_bid_time > 0 AND end_time > EXTRACT(EPOCH FROM NOW())::bigint THEN 0
                WHEN first_bid_time = 0 THEN 2
                ELSE 3
              END AS availability_rank
       FROM ${INDEXER_SCHEMA}.pnd_auctions
       WHERE status = 'active' AND lower(seller) = $7

       UNION ALL
       SELECT lower(nft_contract), token_id::text, 'auction', 'foundation',
              CASE
                WHEN highest_bidder IS NULL THEN 'listed'
                WHEN end_time > 0 AND end_time <= EXTRACT(EPOCH FROM NOW())::bigint THEN 'settling'
                ELSE 'active'
              END,
              lower(seller),
              CASE WHEN highest_bidder IS NULL THEN reserve_price ELSE highest_bid END::text,
              reserve_price::text,
              CASE WHEN highest_bidder IS NULL THEN NULL ELSE highest_bid::text END,
              NULLIF(end_time, 0)::text,
              to_timestamp(created_at_time), NULL, 'indexed', NULL,
              auction_id::text,
              CASE
                WHEN highest_bidder IS NOT NULL AND end_time > EXTRACT(EPOCH FROM NOW())::bigint THEN 0
                WHEN highest_bidder IS NULL THEN 2
                ELSE 3
              END
       FROM ${INDEXER_SCHEMA}.fnd_auctions
       WHERE status = 'active' AND lower(seller) = $7

       UNION ALL
       SELECT lower(nft_contract), token_id::text, 'buy-now', 'foundation',
              'buy-now', lower(seller), price::text, NULL, NULL, NULL,
              to_timestamp(COALESCE(updated_at_time, created_at_time)), NULL,
              'indexed', NULL, NULL, 1
       FROM ${INDEXER_SCHEMA}.fnd_buy_nows
       WHERE status = 'active' AND lower(seller) = $7

       UNION ALL
       SELECT lower(contract), token_id, 'auction', 'superrare',
              CASE
                WHEN current_bid_wei::numeric = 0 THEN 'listed'
                WHEN end_time > 0 AND end_time <= EXTRACT(EPOCH FROM NOW())::bigint THEN 'settling'
                ELSE 'active'
              END,
              lower(seller),
              CASE WHEN current_bid_wei::numeric = 0 THEN reserve_wei ELSE current_bid_wei END,
              reserve_wei,
              CASE WHEN current_bid_wei::numeric = 0 THEN NULL ELSE current_bid_wei END,
              NULLIF(end_time, 0)::text, updated_at, last_observed_block::text,
              'fresh', NULL, NULL,
              CASE
                WHEN current_bid_wei::numeric > 0 AND end_time > EXTRACT(EPOCH FROM NOW())::bigint THEN 0
                WHEN current_bid_wei::numeric = 0 THEN 2
                ELSE 3
              END
       FROM public.srv2_active_auctions
       WHERE status = 'active' AND lower(seller) = $7
         AND updated_at >= NOW() - INTERVAL '${OBSERVED_SOURCE_FRESHNESS_MINUTES} minutes'

       UNION ALL
       SELECT lower(contract), token_id, 'auction', 'transient',
              CASE
                WHEN current_bid_wei::numeric = 0 THEN 'listed'
                WHEN end_time > 0 AND end_time <= EXTRACT(EPOCH FROM NOW())::bigint THEN 'settling'
                ELSE 'active'
              END,
              lower(seller),
              CASE WHEN current_bid_wei::numeric = 0 THEN reserve_wei ELSE current_bid_wei END,
              reserve_wei,
              CASE WHEN current_bid_wei::numeric = 0 THEN NULL ELSE current_bid_wei END,
              NULLIF(end_time, 0)::text, updated_at, last_observed_block::text,
              'fresh', NULL, NULL,
              CASE
                WHEN current_bid_wei::numeric > 0 AND end_time > EXTRACT(EPOCH FROM NOW())::bigint THEN 0
                WHEN current_bid_wei::numeric = 0 THEN 2
                ELSE 3
              END
       FROM public.tl_active_auctions
       WHERE status = 'active' AND listing_type = 2 AND lower(seller) = $7
         AND updated_at >= NOW() - INTERVAL '${OBSERVED_SOURCE_FRESHNESS_MINUTES} minutes'
     ),
     best_available AS (
       SELECT DISTINCT ON (contract, token_id) *
       FROM available
       ORDER BY contract, token_id, availability_rank, observed_at DESC NULLS LAST
     ),
     ranked AS (
       SELECT r.*, a.kind, a.source, a.availability_status, a.seller,
              a.price, a.reserve_price, a.current_bid, a.end_time, a.observed_at,
              a.observed_block, a.freshness, a.destination, a.auction_id,
              COUNT(*) OVER ()::int AS total_count,
              COUNT(a.contract) FILTER (
                WHERE a.availability_status IN ('listed', 'active', 'buy-now')
              ) OVER ()::int AS available_count
       FROM refs r
       LEFT JOIN best_available a
         ON a.contract = r.contract AND a.token_id = r.token_id
       ORDER BY COALESCE(a.availability_rank, 9), r.mint_block DESC,
                r.ordinality, r.contract, r.token_id
       LIMIT $8 OFFSET $9
     )
       SELECT *, mint_block::text AS mint_block FROM ranked`,
      [contracts, tokenIds, creators, collectionNames, platforms, mintBlocks, artist.toLowerCase(), pageSize, offset],
    )) as RankedRow[]
  } catch (error) {
    // Rolling deploys can briefly pair new web code with the previous
    // indexer schema. Keep the indexed work visible in its durable mint order
    // and state plainly that availability could not be verified.
    console.warn("[artist-availability] ranked availability unavailable:", error)
    return fallback
  }

  const availability = new Map<string, WorkAvailability>()
  const pageRefs = rows.map((row) => {
    if (row.kind && row.source && row.availability_status && row.seller && row.price) {
      availability.set(`${row.contract}:${row.token_id}`, {
        kind: row.kind,
        source: row.source,
        status: row.availability_status,
        seller: row.seller,
        price: row.price,
        reservePrice: row.reserve_price,
        currentBid: row.current_bid,
        endTime: row.end_time,
        observedAt: toIso(row.observed_at),
        observedBlock: row.observed_block,
        freshness: row.freshness ?? "indexed",
        destination: row.destination,
        auctionId: row.auction_id,
      })
    }
    return {
      contract: row.contract as `0x${string}`,
      tokenId: row.token_id,
      creator: row.creator as `0x${string}`,
      collectionName: row.collection_name,
      platform: row.platform,
      mintBlock: row.mint_block,
    }
  })

  let staleRows: Array<{ source: string }> = []
  try {
    staleRows = (await sql`
      SELECT source
      FROM (
        SELECT 'SuperRare'::text AS source, MAX(updated_at) AS last_seen
        FROM srv2_active_auctions
        WHERE lower(seller) = ${artist.toLowerCase()} AND status = 'active'
        UNION ALL
        SELECT 'Transient Labs', MAX(updated_at)
        FROM tl_active_auctions
        WHERE lower(seller) = ${artist.toLowerCase()} AND status = 'active'
      ) s
      WHERE last_seen IS NOT NULL
        AND last_seen < NOW() - (${OBSERVED_SOURCE_FRESHNESS_MINUTES}::text || ' minutes')::interval
    `) as Array<{ source: string }>
  } catch (error) {
    // Freshness is supplementary coverage metadata. It must not hide a
    // successfully ranked gallery when telemetry tables are rolling out.
    console.warn("[artist-availability] freshness coverage unavailable:", error)
  }

  const total = rows[0]?.total_count ?? refs.length
  return {
    refs: pageRefs,
    availability,
    total,
    availableTotal: rows[0]?.available_count ?? 0,
    coverage: {
      indexedSources: ["Foundation", "Manifold", "Mint", "PND", "SuperRare", "Transient Labs"],
      hiddenStaleSources: staleRows.map((r) => r.source),
      note:
        "Availability comes from PND and Foundation events plus recent SuperRare and Transient observations. Listings are hidden when PND can no longer confirm that they are current.",
    },
  }
}
