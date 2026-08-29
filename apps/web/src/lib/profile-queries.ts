import "server-only"
import { sql } from "./db"
import { getCachedTokenRefs } from "./artist-cache"
import { rankArtistTokenRefs } from "./artist-availability"
import { tokenToDisplayData, type GalleryPage } from "./artist-queries"
import { enrichTokens } from "./onchain-discovery"
import { getMediaDeliveries } from "./media-delivery"
import {
  decodeProfileCursor,
  encodeProfileCursor,
} from "./profile-cursor"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g,
  "",
)
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
const MAX_PAGE_SIZE = 48

export type ProfileRole = "artist" | "collector" | "curator"

export type ProfileCoverageSource = {
  source: string
  status: "complete" | "partial" | "snapshot" | "stale"
  finalized: boolean
  observedAt: string | null
  itemCount: number
}

export type ProfileSummary = {
  roles: ProfileRole[]
  createdTotal: number
  availableTotal: number
  openReleaseTotal: number
  heldTotal: number
  declaredTotal: number
  transferredTotal: number
  creatorHeldTotal: number
  surfaceCount: number
  auctionHouseCount: number
  ownershipCoverage: ProfileCoverageSource[]
  coverageNote: string
}

export type ProfileHolding = {
  contract: string
  tokenId: string
  tokenStandard: "erc721" | "erc1155"
  balance: string
  creator: string | null
  platform: string | null
  title: string
  ownershipSource: string
  lastBlock: string
  logIndex: string
  observedAt: string
  finalized: boolean
  coverageStatus: ProfileCoverageSource["status"]
}

export type ProfileTransferredWork = {
  contract: string
  tokenId: string
  platform: string
  title: string
  currentOwner: string | null
  state: "transferred" | "burned" | "sold"
  saleSource: "foundation" | "pnd" | null
  salePrice: string | null
  saleBuyer: string | null
  saleTime: string | null
  saleTxHash: string | null
  mintBlock: string
  mintLogIndex: string
  ownershipObservedAt: string | null
  ownershipFinalized: boolean | null
  ownershipCoverage: ProfileCoverageSource["status"] | null
}

export type ProfileCatalogEvidence = {
  contracts: Array<{ contract: string; declaredAt: string }>
  tokens: Array<{
    contract: string
    tokenId: string
    declaredAt: string
    indexed: boolean
  }>
  ranges: Array<{
    contract: string
    startTokenId: string
    endTokenId: string
    declaredAt: string
  }>
}

export type ProfileOpenRelease = {
  collection: string
  name: string
  symbol: string | null
  price: string
  dynamicPrice: boolean
  mintStart: string
  mintEnd: string
  minted: string
  supplyCap: string
  sold: string
  saleCap: string
  updatedAt: string
}

export type KeysetPage<T> = {
  items: T[]
  nextCursor: string | null
}

type SummaryArgs = {
  address: string
  createdTotal: number
  availableTotal: number
  openReleaseTotal: number
  declaredTotal: number
}

function asIso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function safePageSize(value: number): number {
  if (!Number.isFinite(value)) return 24
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(value)))
}

export async function getProfileSummary(args: SummaryArgs): Promise<ProfileSummary> {
  const address = args.address.toLowerCase()
  let heldTotal = 0
  let transferredTotal = 0
  let creatorHeldTotal = 0
  let surfaceCount = 0
  let auctionHouseCount = 0
  let ownershipCoverage: ProfileCoverageSource[] = []

  if (sql) {
    const [counts, coverage, infrastructure] = await Promise.all([
      sql`
        SELECT
          (SELECT COUNT(*)::int FROM profile_collected_works WHERE holder = ${address}) AS held_total,
          (SELECT COUNT(*)::int FROM profile_created_works
             WHERE artist = ${address} AND lifecycle_evidence IN ('transferred', 'burned')) AS transferred_total,
          (SELECT COUNT(*)::int FROM profile_created_works
             WHERE artist = ${address} AND lifecycle_evidence = 'creator-held') AS creator_held_total
      `.catch(() => []),
      sql`
        SELECT ownership_source AS source,
               coverage_status,
               BOOL_AND(finalized) AS finalized,
               MAX(observed_at) AS observed_at,
               COUNT(*)::int AS item_count
        FROM profile_collected_works
        WHERE holder = ${address}
        GROUP BY ownership_source, coverage_status
        ORDER BY ownership_source, coverage_status
      `.catch(() => []),
      sql.unsafe(
        `SELECT
           (SELECT COUNT(*)::int FROM ${INDEXER_SCHEMA}.collections WHERE lower(owner) = $1) AS surface_count,
           (SELECT COUNT(*)::int FROM ${INDEXER_SCHEMA}.pnd_houses WHERE lower(owner) = $1) AS house_count`,
        [address],
      ).catch(() => []),
    ])

    const countRow = counts[0] as Record<string, number> | undefined
    heldTotal = countRow?.held_total ?? 0
    transferredTotal = countRow?.transferred_total ?? 0
    creatorHeldTotal = countRow?.creator_held_total ?? 0

    ownershipCoverage = (coverage as Array<{
      source: string
      coverage_status: ProfileCoverageSource["status"]
      finalized: boolean
      observed_at: Date | string | null
      item_count: number
    }>).map((row) => ({
      source: row.source,
      status: row.coverage_status,
      finalized: row.finalized,
      observedAt: asIso(row.observed_at),
      itemCount: row.item_count,
    }))

    const infra = infrastructure[0] as { surface_count?: number; house_count?: number } | undefined
    surfaceCount = infra?.surface_count ?? 0
    auctionHouseCount = infra?.house_count ?? 0
  }

  const artistEvidence =
    args.createdTotal > 0 || args.declaredTotal > 0 || surfaceCount > 0 || auctionHouseCount > 0
  const roles: ProfileRole[] = []
  if (artistEvidence) roles.push("artist")
  if (heldTotal > 0) roles.push("collector")
  // Curator is reserved for a future signed exhibition/list source. Catalog
  // declaration is artist evidence and must never manufacture this role.

  return {
    roles,
    createdTotal: args.createdTotal,
    availableTotal: args.availableTotal,
    openReleaseTotal: args.openReleaseTotal,
    heldTotal,
    declaredTotal: args.declaredTotal,
    transferredTotal,
    creatorHeldTotal,
    surfaceCount,
    auctionHouseCount,
    ownershipCoverage,
    coverageNote:
      "This profile covers work and ownership observed by PND's indexed sources. It is not a complete wallet inventory or career record.",
  }
}

/**
 * PND-native primary releases whose indexed FixedPriceMinter window and both
 * scarcity ceilings are currently open. This is collection-level availability,
 * separate from listings of already-minted work.
 */
export async function getProfileOpenReleases(
  addressInput: string,
): Promise<ProfileOpenRelease[]> {
  if (!sql) return []
  const address = addressInput.toLowerCase()
  try {
    const rows = await sql.unsafe(
      `WITH mint_totals AS (
         SELECT lower(collection) AS collection,
                COALESCE(SUM(quantity), 0)::text AS minted
         FROM ${INDEXER_SCHEMA}.collection_mints
         GROUP BY lower(collection)
       ),
       sale_totals AS (
         SELECT lower(collection) AS collection, lower(minter) AS minter,
                COALESCE(SUM(quantity), 0)::text AS sold
         FROM ${INDEXER_SCHEMA}.collection_sales
         GROUP BY lower(collection), lower(minter)
       )
       SELECT lower(c.collection) AS collection,
              COALESCE(c.name, c.symbol, 'Untitled Surface') AS name,
              c.symbol,
              s.price::text,
              lower(s.price_strategy) <> $2 AS dynamic_price,
              s.mint_start::text, s.mint_end::text,
              COALESCE(mt.minted, '0') AS minted,
              sc.supply_cap::text AS supply_cap,
              COALESCE(st.sold, '0') AS sold,
              s.max_mints::text AS sale_cap,
              to_timestamp(s.updated_at_time)::text AS updated_at
       FROM ${INDEXER_SCHEMA}.collections c
       JOIN ${INDEXER_SCHEMA}.collection_supply_configs sc
         ON lower(sc.collection) = lower(c.collection)
       JOIN ${INDEXER_SCHEMA}.minter_sale_configs s
         ON lower(s.minter) = lower(c.primary_minter)
        AND lower(s.collection) = lower(c.collection)
       LEFT JOIN mint_totals mt ON mt.collection = lower(c.collection)
       LEFT JOIN sale_totals st
         ON st.collection = lower(c.collection) AND st.minter = lower(s.minter)
       WHERE lower(c.owner) = $1
         AND (s.mint_start = 0 OR s.mint_start <= EXTRACT(EPOCH FROM NOW())::bigint)
         AND (s.mint_end = 0 OR s.mint_end > EXTRACT(EPOCH FROM NOW())::bigint)
         AND (s.max_mints = 0 OR COALESCE(st.sold, '0')::numeric < s.max_mints)
         AND (sc.supply_cap = 0
              OR COALESCE(mt.minted, '0')::numeric < sc.supply_cap)
       ORDER BY s.updated_at_block DESC, c.collection`,
      [address, ZERO_ADDRESS],
    ) as Array<{
      collection: string
      name: string
      symbol: string | null
      price: string
      dynamic_price: boolean
      mint_start: string
      mint_end: string
      minted: string
      supply_cap: string
      sold: string
      sale_cap: string
      updated_at: string
    }>
    return rows.map((row) => ({
      collection: row.collection,
      name: row.name,
      symbol: row.symbol,
      price: row.price,
      dynamicPrice: row.dynamic_price,
      mintStart: row.mint_start,
      mintEnd: row.mint_end,
      minted: row.minted,
      supplyCap: row.supply_cap,
      sold: row.sold,
      saleCap: row.sale_cap,
      updatedAt: row.updated_at,
    }))
  } catch {
    return []
  }
}

export async function getProfileCatalogEvidence(
  addressInput: string,
): Promise<ProfileCatalogEvidence> {
  const empty: ProfileCatalogEvidence = { contracts: [], tokens: [], ranges: [] }
  if (!sql) return empty
  const address = addressInput.toLowerCase()
  try {
    const [contracts, tokens, ranges] = await Promise.all([
      sql.unsafe(
        `SELECT lower(contract_address) AS contract, block_time::text AS declared_at
         FROM ${INDEXER_SCHEMA}.catalog_contracts
         WHERE lower(artist) = $1
         ORDER BY block_number DESC, contract_address`,
        [address],
      ),
      sql.unsafe(
        `SELECT lower(c.contract_address) AS contract,
                c.token_id::text AS token_id,
                c.block_time::text AS declared_at,
                EXISTS (
                  SELECT 1 FROM public.artist_tokens at
                  WHERE lower(at.contract) = lower(c.contract_address)
                    AND at.token_id = c.token_id::text
                ) AS indexed
         FROM ${INDEXER_SCHEMA}.catalog_tokens c
         WHERE lower(c.artist) = $1
         ORDER BY c.block_number DESC, c.contract_address, c.token_id`,
        [address],
      ),
      sql.unsafe(
        `SELECT lower(contract_address) AS contract,
                start_token_id::text, end_token_id::text,
                block_time::text AS declared_at
         FROM ${INDEXER_SCHEMA}.catalog_ranges
         WHERE lower(artist) = $1
         ORDER BY block_number DESC, contract_address, start_token_id`,
        [address],
      ),
    ])
    return {
      contracts: (contracts as unknown as Array<{ contract: string; declared_at: string }>).map((row) => ({
        contract: row.contract,
        declaredAt: row.declared_at,
      })),
      tokens: (tokens as unknown as Array<{
        contract: string
        token_id: string
        declared_at: string
        indexed: boolean
      }>).map((row) => ({
        contract: row.contract,
        tokenId: row.token_id,
        declaredAt: row.declared_at,
        indexed: row.indexed,
      })),
      ranges: (ranges as unknown as Array<{
        contract: string
        start_token_id: string
        end_token_id: string
        declared_at: string
      }>).map((row) => ({
        contract: row.contract,
        startTokenId: row.start_token_id,
        endTokenId: row.end_token_id,
        declaredAt: row.declared_at,
      })),
    }
  } catch {
    return empty
  }
}

/** Profile gallery path: Postgres enrichment only, never courtesy ownerOf/tokenURI. */
export async function getProfileGalleryPage(
  addressInput: string,
  page = 0,
  pageSize = 24,
): Promise<GalleryPage> {
  const address = addressInput.toLowerCase()
  const refs = await getCachedTokenRefs(address, true)
  const ranked = await rankArtistTokenRefs(address, refs, page, pageSize)
  const [enriched, mediaDeliveries] = await Promise.all([
    enrichTokens(ranked.refs, { resolveMissing: false }),
    getMediaDeliveries(ranked.refs),
  ])
  const tokens = enriched.map((token) => {
    const key = `${token.contract.toLowerCase()}:${token.tokenId}`
    const display = tokenToDisplayData(token)
    const availability = ranked.availability.get(key) ?? null
    return {
      ...display,
      mediaDelivery: mediaDeliveries.get(key) ?? null,
      availability,
      buyPrice: availability?.kind === "buy-now"
        ? { seller: availability.seller, price: availability.price }
        : null,
      auction: null,
      muriUriCount: null,
    }
  })
  return {
    tokens,
    total: ranked.total,
    page,
    pageSize,
    hasMore: (page + 1) * pageSize < ranked.total,
    availableTotal: ranked.availableTotal,
    coverage: ranked.coverage,
  }
}

type HoldingRow = {
  contract: string
  token_id: string
  token_standard: "erc721" | "erc1155"
  balance: string
  attributed_creator: string | null
  platform: string | null
  name: string | null
  ownership_source: string
  last_block: string
  log_index: string
  observed_at: Date | string
  finalized: boolean
  coverage_status: ProfileCoverageSource["status"]
}

export async function getProfileHoldingsPage(
  addressInput: string,
  cursorInput: string | null,
  pageSizeInput = 24,
): Promise<KeysetPage<ProfileHolding>> {
  if (!sql) return { items: [], nextCursor: null }
  const address = addressInput.toLowerCase()
  const cursor = decodeProfileCursor(cursorInput)
  const pageSize = safePageSize(pageSizeInput)
  const rows = (await sql`
    SELECT p.contract, p.token_id, p.token_standard, p.balance::text,
           p.attributed_creator, p.platform, m.name,
           p.ownership_source, p.last_block::text, p.log_index::text,
           p.observed_at, p.finalized, p.coverage_status
    FROM profile_collected_works p
    LEFT JOIN token_metadata m
      ON lower(m.contract) = p.contract AND m.token_id = p.token_id
    WHERE p.holder = ${address}
      AND (
        ${cursor?.block ?? null}::bigint IS NULL OR
        (p.last_block, p.log_index, p.contract, p.token_id)
          < (${cursor?.block ?? null}::bigint, ${cursor?.logIndex ?? null}::bigint,
             ${cursor?.contract ?? null}::text, ${cursor?.tokenId ?? null}::text)
      )
    ORDER BY p.last_block DESC, p.log_index DESC, p.contract DESC, p.token_id DESC
    LIMIT ${pageSize + 1}
  `.catch(() => [])) as HoldingRow[]

  const hasMore = rows.length > pageSize
  const visible = rows.slice(0, pageSize)
  const items = visible.map((row) => ({
    contract: row.contract,
    tokenId: row.token_id,
    tokenStandard: row.token_standard,
    balance: row.balance,
    creator: row.attributed_creator,
    platform: row.platform,
    title: row.name || `#${row.token_id}`,
    ownershipSource: row.ownership_source,
    lastBlock: row.last_block,
    logIndex: row.log_index,
    observedAt: asIso(row.observed_at)!,
    finalized: row.finalized,
    coverageStatus: row.coverage_status,
  }))
  const last = visible.at(-1)
  return {
    items,
    nextCursor: hasMore && last
      ? encodeProfileCursor({
          block: last.last_block,
          logIndex: last.log_index,
          contract: last.contract,
          tokenId: last.token_id,
        })
      : null,
  }
}

type TransferredRow = {
  contract: string
  token_id: string
  platform: string
  name: string | null
  current_owner: string | null
  lifecycle_evidence: "transferred" | "burned"
  mint_block: string
  mint_log_index: string
  ownership_observed_at: Date | string | null
  ownership_finalized: boolean | null
  ownership_coverage: ProfileCoverageSource["status"] | null
  sale_source: "foundation" | "pnd" | null
  sale_price: string | null
  sale_buyer: string | null
  sale_time: string | null
  sale_tx_hash: string | null
}

export async function getProfileTransferredPage(
  addressInput: string,
  cursorInput: string | null,
  pageSizeInput = 24,
): Promise<KeysetPage<ProfileTransferredWork>> {
  if (!sql) return { items: [], nextCursor: null }
  const address = addressInput.toLowerCase()
  const cursor = decodeProfileCursor(cursorInput)
  const pageSize = safePageSize(pageSizeInput)
  const rows = (await sql.unsafe(
    `WITH all_sales AS (
       SELECT lower(nft_contract) AS contract, token_id::text AS token_id,
              'foundation'::text AS sale_source, price_wei::text AS sale_price,
              lower(buyer) AS sale_buyer, block_time::text AS sale_time,
              tx_hash::text AS sale_tx_hash
       FROM ${INDEXER_SCHEMA}.fnd_sales
       WHERE lower(seller) = $1
       UNION ALL
       SELECT lower(token_contract), token_id::text, 'pnd'::text,
              amount::text, lower(winner), settled_at_time::text,
              lifecycle_tx_hash::text
       FROM ${INDEXER_SCHEMA}.pnd_auctions
       WHERE status = 'settled' AND lower(seller) = $1
     ), latest_sale AS (
       SELECT DISTINCT ON (contract, token_id)
              contract, token_id, sale_source, sale_price, sale_buyer,
              sale_time, sale_tx_hash
       FROM all_sales
       ORDER BY contract, token_id, sale_time::numeric DESC
     )
     SELECT p.contract, p.token_id, p.platform, m.name, p.current_owner,
            p.lifecycle_evidence, p.mint_block::text, p.mint_log_index::text,
            p.ownership_observed_at, p.ownership_finalized, p.ownership_coverage,
            s.sale_source, s.sale_price, s.sale_buyer, s.sale_time, s.sale_tx_hash
     FROM profile_created_works p
     LEFT JOIN token_metadata m
       ON lower(m.contract) = p.contract AND m.token_id = p.token_id
     LEFT JOIN latest_sale s
       ON s.contract = p.contract AND s.token_id = p.token_id
     WHERE p.artist = $1
       AND p.lifecycle_evidence IN ('transferred', 'burned')
       AND (
         $2::bigint IS NULL OR
         (p.mint_block, p.mint_log_index, p.contract, p.token_id)
           < ($2::bigint, $3::bigint, $4::text, $5::text)
       )
     ORDER BY p.mint_block DESC, p.mint_log_index DESC, p.contract DESC, p.token_id DESC
     LIMIT $6`,
    [
      address,
      cursor?.block ?? null,
      cursor?.logIndex ?? null,
      cursor?.contract ?? null,
      cursor?.tokenId ?? null,
      pageSize + 1,
    ],
  ).catch(() => [])) as TransferredRow[]

  const hasMore = rows.length > pageSize
  const visible = rows.slice(0, pageSize)
  const items = visible.map<ProfileTransferredWork>((row) => ({
    contract: row.contract,
    tokenId: row.token_id,
    platform: row.platform,
    title: row.name || `#${row.token_id}`,
    currentOwner: row.current_owner,
    state: row.lifecycle_evidence === "transferred" && row.sale_source
      ? "sold"
      : row.lifecycle_evidence,
    saleSource: row.sale_source,
    salePrice: row.sale_price,
    saleBuyer: row.sale_buyer,
    saleTime: row.sale_time,
    saleTxHash: row.sale_tx_hash,
    mintBlock: row.mint_block,
    mintLogIndex: row.mint_log_index,
    ownershipObservedAt: asIso(row.ownership_observed_at),
    ownershipFinalized: row.ownership_finalized,
    ownershipCoverage: row.ownership_coverage,
  }))
  const last = visible.at(-1)
  return {
    items,
    nextCursor: hasMore && last
      ? encodeProfileCursor({
          block: last.mint_block,
          logIndex: last.mint_log_index,
          contract: last.contract,
          tokenId: last.token_id,
        })
      : null,
  }
}

export function isProfileAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS
}
