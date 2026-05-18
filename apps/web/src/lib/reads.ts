import "server-only"
import { sql } from "./db"

/**
 * The entire data-fetching surface for the v2 web app.
 *
 * Every function here is a pure Postgres SELECT against tables the
 * worker or Ponder populates. No fallback chains. No chain reads.
 * If the data isn't there, the answer is "not yet" — and a worker
 * job is presumed to be in flight (or one can be enqueued via
 * `lib/external-indexer:refreshArtist` → worker /jobs).
 *
 * For genuinely-mutable live state (current bid amount, current owner
 * older than X minutes, active SR/TL auctions per artist), see
 * `lib/onchain.ts` — six functions, each pgCache-wrapped.
 */

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

// Helper to inline a schema-qualified table name into raw SQL.
const t = (name: string) => `${INDEXER_SCHEMA}.${name}`

// ─── Artist queries ──────────────────────────────────────────────────────

export type ArtistTokenRow = {
  contract: string
  tokenId: string
  platform: string
  mintBlock: bigint
  mintLogIndex: number
  name: string | null
  imageUrl: string | null
  animationUrl: string | null
  owner: string | null
}

export async function getArtistTokens(
  artist: string,
  page = 0,
  pageSize = 24,
): Promise<{ tokens: ArtistTokenRow[]; total: number }> {
  if (!sql) return { tokens: [], total: 0 }
  const lower = artist.toLowerCase()
  const offset = page * pageSize

  // UNION every per-platform source.
  const totalRows = (await sql.unsafe(
    `WITH refs AS (
       SELECT lower(contract) AS contract, token_id, platform,
              mint_block, mint_log_index
       FROM artist_tokens WHERE artist = $1
       UNION ALL
       SELECT lower(contract), token_id::text, 'fnd-shared'::text,
              block_number, log_index
       FROM ${t("fnd_artist_tokens")} WHERE lower(creator) = $1
       UNION ALL
       SELECT lower(contract), token_id::text, 'srv2-shared'::text,
              block_number, log_index
       FROM ${t("srv2_artist_tokens")} WHERE lower(creator) = $1
     )
     SELECT count(*)::int AS n FROM refs`,
    [lower],
  )) as Array<{ n: number }>
  const total = totalRows[0]?.n ?? 0

  const rows = (await sql.unsafe(
    `WITH refs AS (
       SELECT lower(contract) AS contract, token_id, platform,
              mint_block, mint_log_index
       FROM artist_tokens WHERE artist = $1
       UNION ALL
       SELECT lower(contract), token_id::text, 'fnd-shared',
              block_number, log_index
       FROM ${t("fnd_artist_tokens")} WHERE lower(creator) = $1
       UNION ALL
       SELECT lower(contract), token_id::text, 'srv2-shared',
              block_number, log_index
       FROM ${t("srv2_artist_tokens")} WHERE lower(creator) = $1
     )
     SELECT r.contract, r.token_id, r.platform,
            r.mint_block::text AS mint_block, r.mint_log_index,
            m.name, m.image_url, m.animation_url, o.owner
     FROM refs r
     LEFT JOIN token_metadata m
       ON m.contract = r.contract AND m.token_id = r.token_id
     LEFT JOIN token_owners o
       ON o.contract = r.contract AND o.token_id = r.token_id
     ORDER BY r.mint_block DESC, r.mint_log_index DESC
     LIMIT $2 OFFSET $3`,
    [lower, pageSize, offset],
  )) as Array<{
    contract: string
    token_id: string
    platform: string
    mint_block: string
    mint_log_index: number
    name: string | null
    image_url: string | null
    animation_url: string | null
    owner: string | null
  }>

  return {
    tokens: rows.map((r) => ({
      contract: r.contract,
      tokenId: r.token_id,
      platform: r.platform,
      mintBlock: BigInt(r.mint_block),
      mintLogIndex: r.mint_log_index,
      name: r.name,
      imageUrl: r.image_url,
      animationUrl: r.animation_url,
      owner: r.owner,
    })),
    total,
  }
}

// ─── Token detail ────────────────────────────────────────────────────────

export type TokenDetail = {
  contract: string
  tokenId: string
  name: string | null
  description: string | null
  imageUrl: string | null
  animationUrl: string | null
  owner: string | null
  creator: string | null
  transfers: Array<{
    fromAddr: string
    toAddr: string
    blockNumber: bigint
    blockTime: bigint
    txHash: string
  }>
}

export async function getTokenDetail(
  contract: string,
  tokenId: string,
): Promise<TokenDetail | null> {
  if (!sql) return null
  const contractLower = contract.toLowerCase()

  const meta = (await sql`
    SELECT name, description, image_url, animation_url
    FROM token_metadata
    WHERE contract = ${contractLower} AND token_id = ${tokenId}
    LIMIT 1
  `) as Array<{
    name: string | null
    description: string | null
    image_url: string | null
    animation_url: string | null
  }>

  const owner = (await sql`
    SELECT owner FROM token_owners
    WHERE contract = ${contractLower} AND token_id = ${tokenId}
    LIMIT 1
  `) as Array<{ owner: string }>

  // Creator: try worker artist_tokens, fall back to Ponder shared-contract tables.
  const creator = (await sql.unsafe(
    `SELECT artist AS creator FROM artist_tokens
       WHERE contract = $1 AND token_id = $2
       LIMIT 1`,
    [contractLower, tokenId],
  )) as Array<{ creator: string }>

  let creatorAddr = creator[0]?.creator ?? null
  if (!creatorAddr) {
    const shared = (await sql.unsafe(
      `SELECT lower(creator) AS creator FROM ${t("fnd_artist_tokens")}
         WHERE lower(contract) = $1 AND token_id::text = $2
         LIMIT 1`,
      [contractLower, tokenId],
    )) as Array<{ creator: string }>
    creatorAddr = shared[0]?.creator ?? null
  }
  if (!creatorAddr) {
    const sr = (await sql.unsafe(
      `SELECT lower(creator) AS creator FROM ${t("srv2_artist_tokens")}
         WHERE lower(contract) = $1 AND token_id::text = $2
         LIMIT 1`,
      [contractLower, tokenId],
    )) as Array<{ creator: string }>
    creatorAddr = sr[0]?.creator ?? null
  }

  const transfers = (await sql`
    SELECT from_addr, to_addr, block_number::text AS block_number,
           block_time::text AS block_time, tx_hash
    FROM token_transfers
    WHERE contract = ${contractLower} AND token_id = ${tokenId}
    ORDER BY block_number DESC, log_index DESC
    LIMIT 50
  `) as Array<{
    from_addr: string
    to_addr: string
    block_number: string
    block_time: string
    tx_hash: string
  }>

  if (!meta[0] && !owner[0] && !creatorAddr && transfers.length === 0) {
    return null
  }

  return {
    contract: contractLower,
    tokenId,
    name: meta[0]?.name ?? null,
    description: meta[0]?.description ?? null,
    imageUrl: meta[0]?.image_url ?? null,
    animationUrl: meta[0]?.animation_url ?? null,
    owner: owner[0]?.owner ?? null,
    creator: creatorAddr,
    transfers: transfers.map((tr) => ({
      fromAddr: tr.from_addr,
      toAddr: tr.to_addr,
      blockNumber: BigInt(tr.block_number),
      blockTime: BigInt(tr.block_time),
      txHash: tr.tx_hash,
    })),
  }
}

// ─── Collector (inverse query) ───────────────────────────────────────────

export async function getCollectorTokens(
  wallet: string,
): Promise<Array<{ contract: string; tokenId: string }>> {
  if (!sql) return []
  const lower = wallet.toLowerCase()
  const rows = (await sql`
    SELECT contract, token_id FROM token_owners WHERE owner = ${lower}
    ORDER BY transferred_at_block DESC
    LIMIT 200
  `) as Array<{ contract: string; token_id: string }>
  return rows.map((r) => ({ contract: r.contract, tokenId: r.token_id }))
}

// ─── Active auctions for an artist ───────────────────────────────────────

export type ActivePndAuction = {
  house: string
  tokenContract: string
  tokenId: string
  seller: string
  amount: bigint
  reservePrice: bigint
  endTime: number
}

export async function getActivePndAuctionsForArtist(
  artist: string,
): Promise<ActivePndAuction[]> {
  if (!sql) return []
  const lower = artist.toLowerCase()
  const rows = (await sql.unsafe(
    `SELECT house, token_contract, token_id::text AS token_id, seller,
            amount::text AS amount, reserve_price::text AS reserve_price,
            end_time::text AS end_time
     FROM ${t("pnd_auctions")}
     WHERE lower(seller) = $1 AND status = 'active'
     ORDER BY created_at_time DESC`,
    [lower],
  )) as Array<{
    house: string
    token_contract: string
    token_id: string
    seller: string
    amount: string
    reserve_price: string
    end_time: string
  }>
  return rows.map((r) => ({
    house: r.house,
    tokenContract: r.token_contract,
    tokenId: r.token_id,
    seller: r.seller,
    amount: BigInt(r.amount),
    reservePrice: BigInt(r.reserve_price),
    endTime: Number(r.end_time),
  }))
}

export async function getActivePndAuctionCount(artist: string): Promise<number> {
  if (!sql) return 0
  const lower = artist.toLowerCase()
  const rows = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${t("pnd_auctions")}
       WHERE lower(seller) = $1 AND status = 'active'`,
    [lower],
  )) as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

// ─── ENS / identity ──────────────────────────────────────────────────────

export type IdentityRow = {
  address: string
  ensName: string | null
  avatarUrl: string | null
}

export async function getIdentity(address: string): Promise<IdentityRow> {
  if (!sql) return { address: address.toLowerCase(), ensName: null, avatarUrl: null }
  const lower = address.toLowerCase()
  const rows = (await sql`
    SELECT ens_name, avatar_url FROM ens_identities WHERE address = ${lower} LIMIT 1
  `) as Array<{ ens_name: string | null; avatar_url: string | null }>
  return {
    address: lower,
    ensName: rows[0]?.ens_name ?? null,
    avatarUrl: rows[0]?.avatar_url ?? null,
  }
}

// ─── Catalog ─────────────────────────────────────────────────────────────

export async function getCatalogForArtist(artist: string): Promise<{
  contracts: Array<{ contractAddress: string; blockTime: bigint }>
  tokens: Array<{ contractAddress: string; tokenId: string; blockTime: bigint }>
  ranges: Array<{ contractAddress: string; startTokenId: string; endTokenId: string }>
}> {
  if (!sql) return { contracts: [], tokens: [], ranges: [] }
  const lower = artist.toLowerCase()

  const [contracts, tokens, ranges] = await Promise.all([
    sql.unsafe(
      `SELECT lower(contract_address) AS contract_address, block_time::text AS block_time
       FROM ${t("catalog_contracts")} WHERE lower(artist) = $1
       ORDER BY block_number DESC`,
      [lower],
    ) as Promise<Array<{ contract_address: string; block_time: string }>>,
    sql.unsafe(
      `SELECT lower(contract_address) AS contract_address, token_id::text, block_time::text AS block_time
       FROM ${t("catalog_tokens")} WHERE lower(artist) = $1
       ORDER BY block_number DESC`,
      [lower],
    ) as Promise<Array<{ contract_address: string; token_id: string; block_time: string }>>,
    sql.unsafe(
      `SELECT lower(contract_address) AS contract_address,
              start_token_id::text, end_token_id::text
       FROM ${t("catalog_ranges")} WHERE lower(artist) = $1
       ORDER BY block_number DESC`,
      [lower],
    ) as Promise<Array<{ contract_address: string; start_token_id: string; end_token_id: string }>>,
  ])

  return {
    contracts: contracts.map((r) => ({
      contractAddress: r.contract_address,
      blockTime: BigInt(r.block_time),
    })),
    tokens: tokens.map((r) => ({
      contractAddress: r.contract_address,
      tokenId: r.token_id,
      blockTime: BigInt(r.block_time),
    })),
    ranges: ranges.map((r) => ({
      contractAddress: r.contract_address,
      startTokenId: r.start_token_id,
      endTokenId: r.end_token_id,
    })),
  }
}

// ─── Last sale ───────────────────────────────────────────────────────────

export async function getLastSale(
  contract: string,
  tokenId: string,
): Promise<{ priceWei: bigint; source: string; blockTime: bigint; txHash: string } | null> {
  if (!sql) return null
  const rows = (await sql.unsafe(
    `SELECT price_wei::text, source, block_time::text, tx_hash
     FROM ${t("fnd_sales")}
     WHERE lower(nft_contract) = $1 AND token_id::text = $2
     ORDER BY block_time DESC LIMIT 1`,
    [contract.toLowerCase(), tokenId],
  )) as Array<{ price_wei: string; source: string; block_time: string; tx_hash: string }>
  if (rows.length === 0) return null
  return {
    priceWei: BigInt(rows[0].price_wei),
    source: rows[0].source,
    blockTime: BigInt(rows[0].block_time),
    txHash: rows[0].tx_hash,
  }
}

// ─── Platform stats (home page counters) ─────────────────────────────────

export async function getPlatformStats(): Promise<{
  housesDeployed: number
  ethSettledWei: bigint
} | null> {
  if (!sql) return null
  const houses = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${t("pnd_houses")}`,
  )) as Array<{ n: number }>
  const settled = (await sql.unsafe(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
     FROM ${t("pnd_auctions")} WHERE status = 'settled'`,
  )) as Array<{ total: string }>
  return {
    housesDeployed: houses[0]?.n ?? 0,
    ethSettledWei: BigInt(settled[0]?.total ?? "0"),
  }
}
