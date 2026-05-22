/**
 * v2 slim version. The v1 onchain-discovery.ts (1436 lines) carried
 * eager-scan fallbacks for every per-artist/per-token discovery path
 * — those are gone in v2; the worker owns all chain scanning.
 *
 * Only the metadata-resolution helpers stay here, used by the few
 * routes that need on-the-spot tokenURI resolution as a courtesy
 * fallback (the warm-metadata worker task populates this table within
 * minutes of a new mint discovery, so the fallback rarely fires).
 *
 * Re-exports types so legacy imports keep resolving while Phase 3
 * call-site rewires happen.
 */
import "server-only"
import { resolveTokenMetadata } from "@pin/token-metadata"
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { sql } from "./db"

export type TokenRef = {
  contract: `0x${string}`
  tokenId: string
  creator: `0x${string}`
  collectionName: string | null
  platform: string
}

/**
 * Enriched token shape consumed by `<PreserveGrid>`, `<MoreFromContract>`,
 * `<WorkArtistCard>`. Preserves the v1 nested-metadata shape so components
 * don't need code changes — only the data wiring underneath changed.
 */
export type DiscoveredToken = {
  contract: `0x${string}`
  tokenId: string
  creator: `0x${string}`
  collectionName: string | null
  platform: string
  metadata?: {
    name?: string | null
    description?: string | null
    image?: string | null
    animation_url?: string | null
  } | null
  /** Resolved HTTP URL for the image (IPFS gateway-rewritten). */
  mediaHttpUrl?: string | null
  /** CID extracted from the image URL (for the /preserve flow). */
  mediaCid?: string | null
  /** CID of the metadata JSON itself (for the /preserve flow). */
  metadataCid?: string | null
  /** Current owner (lowercased), null if unknown. */
  owner?: string | null
}

function getClient() {
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return createPublicClient({ chain: mainnet, transport: http(explicit) })
  const key = process.env.ALCHEMY_API_KEY
  const url = key && !key.startsWith("set-")
    ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
    : "https://eth.drpc.org"
  return createPublicClient({ chain: mainnet, transport: http(url) })
}

/**
 * Try to resolve token metadata directly via RPC + IPFS. ONLY used as
 * a courtesy fallback when the warm-metadata worker hasn't populated
 * token_metadata for a freshly-discovered token. Writes the result
 * back to the DB so the next read is a point lookup.
 */
export type DirectTokenMetadata = {
  name: string | null
  description: string | null
  image: string | null
  animation_url: string | null
  /** Canonical tokenURI the metadata came from (for "verify source" links). */
  rawUri: string | null
}

export async function resolveTokenMetadataDirect(
  contract: string,
  tokenId: string,
): Promise<DirectTokenMetadata | null> {
  if (!sql) return null

  // Check the table first — covers the common case.
  //
  // `raw_uri` is the success signal: the resolver only sets it when it
  // actually fetched the metadata file. So a row WITH raw_uri is final
  // (return it, even if its name/image are sparse — that's the genuine
  // content) and is never re-fetched. A row with raw_uri NULL means the
  // fetch FAILED (e.g. arweave hadn't propagated a fresh mint yet) — that's
  // not a real answer, so we treat it like a cache miss and re-resolve,
  // throttled by a short cooldown so rapid reloads / genuinely-dead links
  // don't fan out. This is what lets a stuck/blank token self-heal on the
  // next view instead of staying blank until the 7-day sweep.
  const RESOLVE_RETRY_COOLDOWN_MS = 60_000
  const rows = (await sql`
    SELECT name, description, image_url, animation_url, raw_uri, fetched_at
    FROM token_metadata
    WHERE contract = ${contract.toLowerCase()} AND token_id = ${tokenId}
    LIMIT 1
  `) as Array<{
    name: string | null
    description: string | null
    image_url: string | null
    animation_url: string | null
    raw_uri: string | null
    fetched_at: Date
  }>
  const row = rows[0]
  if (row) {
    const succeeded = row.raw_uri !== null
    const attemptedRecently =
      Date.now() - new Date(row.fetched_at).getTime() < RESOLVE_RETRY_COOLDOWN_MS
    if (succeeded || attemptedRecently) {
      // Final content, OR a failed row we just attempted — return as-is
      // rather than re-resolving (the sweep / a later view will retry).
      return {
        name: row.name,
        description: row.description,
        image: row.image_url,
        animation_url: row.animation_url,
        rawUri: row.raw_uri,
      }
    }
    // else: failed row, cooldown elapsed → fall through to re-resolve.
  }

  // No row, or a stale failed row. The warm-metadata worker task should beat
  // us to this, but if a user visits within seconds of mint discovery (or a
  // prior fetch failed), we resolve here and write through.
  try {
    const meta = await resolveTokenMetadata(getClient(), contract, tokenId)
    await sql`
      INSERT INTO token_metadata
        (contract, token_id, name, description, image_url, animation_url, raw_uri, fetched_at)
      VALUES
        (${contract.toLowerCase()}, ${tokenId},
         ${meta?.name ?? null}, ${meta?.description ?? null},
         ${meta?.image ?? null}, ${meta?.animation_url ?? null},
         ${meta?.uri ?? null}, NOW())
      ON CONFLICT (contract, token_id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        image_url = EXCLUDED.image_url, animation_url = EXCLUDED.animation_url,
        raw_uri = COALESCE(EXCLUDED.raw_uri, token_metadata.raw_uri), fetched_at = NOW()
    `
    return {
      name: meta?.name ?? null,
      description: meta?.description ?? null,
      image: meta?.image ?? null,
      animation_url: meta?.animation_url ?? null,
      rawUri: meta?.uri ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Legacy shim. v1's `discoverArtistTokenRefs` fanned out to every
 * platform adapter on cache miss. v2 reads from a single Postgres table.
 *
 * This function preserves the same SHAPE so v1 call sites don't break,
 * but the implementation is now a SELECT. Replace call sites with
 * `lib/reads.ts:getArtistTokens` as part of the Phase 3 sweep.
 */
export async function discoverArtistTokenRefs(
  artistAddress: string,
): Promise<TokenRef[]> {
  if (!sql) return []
  const artist = artistAddress.toLowerCase()
  const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
    /[^a-zA-Z0-9_]/g, "",
  )

  // UNION across worker-owned + Ponder-owned per-artist token sources.
  // Each source contributes (contract, tokenId, platform). The reader
  // attaches creator = artist (the address whose page is being viewed)
  // — same convention v1 used.
  const rows = (await sql.unsafe(
    `SELECT lower(contract) AS contract, token_id, platform, mint_block, mint_log_index
     FROM artist_tokens WHERE artist = $1
     UNION ALL
     SELECT lower(contract), token_id::text, 'fnd-shared' AS platform,
            block_number AS mint_block, log_index AS mint_log_index
     FROM ${INDEXER_SCHEMA}.fnd_artist_tokens WHERE lower(creator) = $1
     UNION ALL
     SELECT lower(contract), token_id::text, 'srv2-shared' AS platform,
            block_number AS mint_block, log_index AS mint_log_index
     FROM ${INDEXER_SCHEMA}.srv2_artist_tokens WHERE lower(creator) = $1
     ORDER BY mint_block DESC, mint_log_index DESC`,
    [artist],
  )) as Array<{
    contract: string
    token_id: string
    platform: string
    mint_block: string
    mint_log_index: number
  }>

  return rows.map((r) => ({
    contract: r.contract as `0x${string}`,
    tokenId: r.token_id,
    creator: artist as `0x${string}`,
    collectionName: null,
    platform: r.platform,
  }))
}

/**
 * Legacy v1 alias: refs + enrichment in one call. New code should use
 * `discoverArtistTokenRefs` + `enrichTokens` separately so the refs
 * layer can be cached independently of the enrichment layer.
 */
export async function discoverArtistTokens(
  artistAddress: string,
): Promise<DiscoveredToken[]> {
  const refs = await discoverArtistTokenRefs(artistAddress)
  return enrichTokens(refs)
}

/**
 * Token-detail-page data: owner, creator, transfer history. All reads
 * are Postgres-only — the worker keeps token_owners + token_transfers
 * fresh.
 */
export type TokenOnChainData = {
  owner: string | null
  creator: string | null
  /** v1 field names; the token page renders these directly. */
  transfers: Array<{
    from: string
    to: string
    blockNumber: bigint
    timestamp: number
    txHash: string
  }>
}

export async function getTokenOnChainData(
  contract: string,
  tokenId: string,
): Promise<TokenOnChainData | null> {
  if (!sql) return null
  const c = contract.toLowerCase()
  const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
    /[^a-zA-Z0-9_]/g, "",
  )

  const [owners, transfers] = await Promise.all([
    sql`
      SELECT owner FROM token_owners
      WHERE contract = ${c} AND token_id = ${tokenId} LIMIT 1
    ` as Promise<Array<{ owner: string }>>,
    sql`
      SELECT from_addr, to_addr,
             block_number::text AS block_number,
             block_time::text AS block_time, tx_hash
      FROM token_transfers
      WHERE contract = ${c} AND token_id = ${tokenId}
      ORDER BY block_number DESC, log_index DESC
      LIMIT 50
    ` as Promise<Array<{
      from_addr: string; to_addr: string;
      block_number: string; block_time: string; tx_hash: string
    }>>,
  ])

  // Creator: try worker's artist_tokens first (covers all platforms),
  // then Ponder's shared-contract tables.
  let creator: string | null = null
  const artistRow = (await sql.unsafe(
    `SELECT artist FROM artist_tokens
       WHERE contract = $1 AND token_id = $2 LIMIT 1`,
    [c, tokenId],
  )) as Array<{ artist: string }>
  if (artistRow[0]) creator = artistRow[0].artist
  else {
    const fnd = (await sql.unsafe(
      `SELECT lower(creator) AS creator FROM ${INDEXER_SCHEMA}.fnd_artist_tokens
         WHERE lower(contract) = $1 AND token_id::text = $2 LIMIT 1`,
      [c, tokenId],
    )) as Array<{ creator: string }>
    if (fnd[0]) creator = fnd[0].creator
    else {
      const sr = (await sql.unsafe(
        `SELECT lower(creator) AS creator FROM ${INDEXER_SCHEMA}.srv2_artist_tokens
           WHERE lower(contract) = $1 AND token_id::text = $2 LIMIT 1`,
        [c, tokenId],
      )) as Array<{ creator: string }>
      if (sr[0]) creator = sr[0].creator
    }
  }

  if (owners.length === 0 && transfers.length === 0 && !creator) return null

  return {
    owner: owners[0]?.owner ?? null,
    creator,
    transfers: transfers.map((t) => ({
      from: t.from_addr,
      to: t.to_addr,
      blockNumber: BigInt(t.block_number),
      timestamp: Number(t.block_time),
      txHash: t.tx_hash,
    })),
  }
}

/**
 * ERC-1155 stats: supply + holder count. v1 ran an Alchemy NFT API scan
 * per render with a 60s pgCache; v2 doesn't yet have a worker task that
 * tracks 1155 supply, so this returns null. UI handles that gracefully
 * (renders "—" instead of a count).
 *
 * TODO: extend the worker with a scan-1155-stats task per contract in
 * artist_tokens with platform='mint' (the main 1155 source).
 */
export type Erc1155TokenStats = {
  totalSupply: bigint
  ownerCount: number
  /** v1 returned mint history alongside the stats (ERC-1155 transfer
   * events are how supply/holders are derived). Kept here for token-
   * page call-site compatibility; the v2 stub never populates rows. */
  transfers: Array<{
    from: string
    to: string
    blockNumber: bigint
    timestamp: number
    txHash: string
    amount: bigint
  }>
  creator: string | null
}

export async function getErc1155TokenStats(
  contract: string,
  tokenId: string,
): Promise<Erc1155TokenStats | null> {
  if (!sql) return null
  const rows = (await sql`
    SELECT total_supply, owner_count
    FROM token_1155_stats
    WHERE contract = ${contract.toLowerCase()} AND token_id = ${tokenId}
    LIMIT 1
  `) as Array<{ total_supply: string; owner_count: number }>
  if (rows.length === 0) return null

  // Mint history — one row per mint event, recorded by the worker's
  // mint-clone scanner. from is always the zero address (these are mints),
  // which the token page renders as a "Minted" provenance entry.
  const mints = (await sql`
    SELECT to_addr,
           amount,
           block_number::text AS block_number,
           block_time::text   AS block_time,
           tx_hash
    FROM token_1155_mints
    WHERE contract = ${contract.toLowerCase()} AND token_id = ${tokenId}
    ORDER BY block_number DESC, log_index DESC
    LIMIT 50
  `) as Array<{
    to_addr: string
    amount: string
    block_number: string
    block_time: string | null
    tx_hash: string
  }>

  return {
    totalSupply: BigInt(rows[0].total_supply),
    ownerCount: rows[0].owner_count,
    transfers: mints.map((m) => ({
      from: "0x0000000000000000000000000000000000000000",
      to: m.to_addr,
      blockNumber: BigInt(m.block_number),
      timestamp: m.block_time ? Number(m.block_time) : 0,
      txHash: m.tx_hash,
      amount: BigInt(m.amount),
    })),
    creator: null,
  }
}

/**
 * Foundation-pinned tokens for the /preserve flow. Returns one row per
 * token the artist minted on Foundation (shared 1/1 + their per-artist
 * collections), with the raw tokenURI for IPFS pinning.
 *
 * Worker writes to `token_metadata.raw_uri` so this is a Postgres-only
 * read. v1 ran a scan-on-miss; v2 trusts the worker has resolved by
 * the time the user opens /preserve.
 */
export async function discoverFoundationPinnedTokens(
  artistAddress: string,
): Promise<Array<{
  contract: string
  tokenId: string
  name: string | null
  imageUrl: string | null
  animationUrl: string | null
  rawUri: string | null
}>> {
  if (!sql) return []
  const lower = artistAddress.toLowerCase()
  const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
    /[^a-zA-Z0-9_]/g, "",
  )

  const rows = (await sql.unsafe(
    `WITH refs AS (
       SELECT lower(contract) AS contract, token_id::text AS token_id
       FROM ${INDEXER_SCHEMA}.fnd_artist_tokens
       WHERE lower(creator) = $1
       UNION
       SELECT lower(contract), token_id
       FROM artist_tokens
       WHERE artist = $1 AND platform = 'fnd-collection'
     )
     SELECT r.contract, r.token_id,
            m.name, m.image_url, m.animation_url, m.raw_uri
     FROM refs r
     LEFT JOIN token_metadata m
       ON m.contract = r.contract AND m.token_id = r.token_id`,
    [lower],
  )) as Array<{
    contract: string
    token_id: string
    name: string | null
    image_url: string | null
    animation_url: string | null
    raw_uri: string | null
  }>

  return rows.map((r) => ({
    contract: r.contract,
    tokenId: r.token_id,
    name: r.name,
    imageUrl: r.image_url,
    animationUrl: r.animation_url,
    rawUri: r.raw_uri,
  }))
}

/**
 * Per-page enrichment. v1 multicalled ownerOf + per-token metadata; v2
 * reads from `token_owners` + `token_metadata`. Pure SELECT.
 */
export async function enrichTokens(
  refs: readonly TokenRef[],
): Promise<DiscoveredToken[]> {
  if (refs.length === 0 || !sql) return []

  const keys = refs.map((r) => `${r.contract.toLowerCase()}:${r.tokenId}`)
  const pairs = refs.map((r) => [r.contract.toLowerCase(), r.tokenId] as const)

  // Build a (contract, tokenId) in-list for the JOIN.
  const rows = (await sql`
    WITH wanted (contract, token_id) AS (
      SELECT * FROM unnest(
        ${pairs.map((p) => p[0])}::text[],
        ${pairs.map((p) => p[1])}::text[]
      ) AS t(contract, token_id)
    )
    SELECT w.contract, w.token_id,
           m.name, m.description, m.image_url, m.animation_url,
           o.owner
    FROM wanted w
    LEFT JOIN token_metadata m
      ON m.contract = w.contract AND m.token_id = w.token_id
    LEFT JOIN token_owners o
      ON o.contract = w.contract AND o.token_id = w.token_id
  `) as Array<{
    contract: string
    token_id: string
    name: string | null
    description: string | null
    image_url: string | null
    animation_url: string | null
    owner: string | null
  }>

  const byKey = new Map<string, typeof rows[number]>()
  for (const r of rows) byKey.set(`${r.contract}:${r.token_id}`, r)

  const { ipfsToHttp, extractCid } = await import("@pin/shared")

  return refs.map((ref) => {
    const r = byKey.get(`${ref.contract.toLowerCase()}:${ref.tokenId}`)
    const image = r?.image_url ?? null
    const animation = r?.animation_url ?? null
    const mediaHttpUrl = image ? ipfsToHttp(image) : null
    const mediaCid = image ? extractCid(image) : null
    return {
      ...ref,
      metadata:
        r?.name || r?.description || image || animation
          ? {
              name: r?.name ?? null,
              description: r?.description ?? null,
              image,
              animation_url: animation,
            }
          : null,
      mediaHttpUrl,
      mediaCid,
      metadataCid: null,
      owner: r?.owner ?? null,
    }
  })
}
