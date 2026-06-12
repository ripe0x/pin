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
import { createPublicClient, http, parseAbi } from "viem"
import { mainnet } from "viem/chains"
import { sql } from "./db"
import { pgCache } from "./pg-cache"

export type TokenRef = {
  contract: `0x${string}`
  tokenId: string
  creator: `0x${string}`
  collectionName: string | null
  platform: string
  /** Mint block as a decimal string (refs must stay bigint-free for
   * unstable_cache hashing). Used only for newest-first ordering. */
  mintBlock?: string
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

const EXISTENCE_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ type: "bool" }],
  },
] as const

const ERC721_INTERFACE_ID = "0x80ac58cd" // ERC-165 id for ERC-721

/**
 * On-chain existence check, for the token-not-found UI. Returns:
 *   - `true`  — the token exists (ownerOf returned an address)
 *   - `false` — the token definitively does NOT exist (confirmed ERC-721
 *               contract, but ownerOf reverted)
 *   - `null`  — can't tell (ERC-1155 / non-standard contract, or RPC error)
 *
 * Call this ONLY when the indexer + metadata have nothing — i.e. we're about
 * to render a blank page. We must never 404 a real-but-unindexed token (the
 * indexer can lag a fresh mint, and metadata may be mid-self-heal), so we act
 * solely on a *positive* on-chain signal: ownerOf reverting on a contract we
 * confirmed is ERC-721. If we can't confirm ERC-721 or can't reach the chain,
 * we return null and the caller renders normally rather than claiming 404.
 */
export async function tokenExistsOnChain(
  contract: string,
  tokenId: string,
): Promise<boolean | null> {
  const address = contract as `0x${string}`
  let id: bigint
  try {
    id = BigInt(tokenId)
  } catch {
    return null
  }
  const client = getClient()
  try {
    await client.readContract({
      address,
      abi: EXISTENCE_ABI,
      functionName: "ownerOf",
      args: [id],
    })
    return true
  } catch {
    // ownerOf failed: nonexistent ERC-721 token, an ERC-1155 (no ownerOf),
    // or a transient RPC error. Only conclude "not found" if the contract is
    // a confirmed ERC-721 AND we could actually reach it — if this second
    // call also throws (e.g. network), we fall through to null.
    try {
      const is721 = (await client.readContract({
        address,
        abi: EXISTENCE_ABI,
        functionName: "supportsInterface",
        args: [ERC721_INTERFACE_ID],
      })) as boolean
      return is721 ? false : null
    } catch {
      return null
    }
  }
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
  // The success signal is *content presence*, NOT `raw_uri`: the resolver
  // stamps `raw_uri` onto any parsed JSON, including a gateway error/garbage
  // 200 that has no metadata fields — so a row can have `raw_uri` set yet be
  // useless. A row that has any of name/description/image/animation_url is
  // final and never re-fetched; a content-less row is treated like a cache
  // miss and re-resolved (throttled by a short cooldown so rapid reloads /
  // genuinely-dead links don't fan out). This lets a stuck/blank token
  // self-heal on the next view instead of being pinned forever by a bogus
  // `raw_uri`.
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
    const hasContent = !!(
      row.name || row.description || row.image_url || row.animation_url
    )
    const attemptedRecently =
      Date.now() - new Date(row.fetched_at).getTime() < RESOLVE_RETRY_COOLDOWN_MS
    if (hasContent || attemptedRecently) {
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

  const indexed = rows.map((r) => ({
    contract: r.contract as `0x${string}`,
    tokenId: r.token_id,
    creator: artist as `0x${string}`,
    collectionName: null,
    platform: r.platform,
    mintBlock: r.mint_block,
  }))

  // Unclaimed-artist fallback: artists outside known_artists have no
  // worker-scanned rows, but the frozen FND discovery seeds (migration
  // 023) know their shared-contract mints token-by-token and their
  // deployed collections contract-by-contract. Shared mints come
  // straight from Postgres; collection tokens are enumerated on demand
  // from the chain (one cached getLogs per collection). Indexed rows
  // win on dedup, so an artist's page upgrades in place when they get
  // admitted and the worker takes over.
  const seeded = await discoverSeedTokenRefs(
    artist,
    new Set(indexed.map((r) => `${r.contract}:${r.tokenId}`)),
    new Set(indexed.map((r) => r.contract as string)),
  ).catch(() => [] as TokenRef[])

  return [...indexed, ...seeded].sort((a, b) => {
    const ab = BigInt(a.mintBlock ?? 0)
    const bb = BigInt(b.mintBlock ?? 0)
    return ab === bb ? 0 : ab > bb ? -1 : 1
  })
}

/** Per-artist seed discovery for the unclaimed-page path. */
async function discoverSeedTokenRefs(
  artist: string,
  haveToken: Set<string>,
  haveContract: Set<string>,
): Promise<TokenRef[]> {
  if (!sql) return []
  const FND_SHARED = "0x3b3ee1931dc30c1957379fac9aba94d1c48a5405"

  const [sharedMints, collections] = await Promise.all([
    sql.unsafe(
      `SELECT token_id, mint_block::text AS mint_block, mint_log_index
       FROM fnd_shared_mints_seed WHERE creator = $1`,
      [artist],
    ) as Promise<Array<{ token_id: string; mint_block: string; mint_log_index: number }>>,
    // Cap the on-demand enumeration: p99 of creators have ≤8 collections,
    // but the max is 467 — a page view must not fan out hundreds of
    // getLogs. Newest 40 collections cover real artists; outliers get
    // full coverage if and when they're admitted and the worker scans.
    sql.unsafe(
      `SELECT collection, deploy_block::text AS deploy_block
       FROM fnd_collections_seed WHERE creator = $1
       ORDER BY deploy_block DESC LIMIT 40`,
      [artist],
    ) as Promise<Array<{ collection: string; deploy_block: string }>>,
  ])

  const refs: TokenRef[] = []
  for (const m of sharedMints) {
    if (haveToken.has(`${FND_SHARED}:${m.token_id}`)) continue
    refs.push({
      contract: FND_SHARED as `0x${string}`,
      tokenId: m.token_id,
      creator: artist as `0x${string}`,
      collectionName: null,
      platform: "fnd-shared",
      mintBlock: m.mint_block,
    })
  }

  // Worker-scanned collections already contribute their tokens via
  // artist_tokens — only enumerate collections the index doesn't cover.
  const unscanned = collections.filter((c) => !haveContract.has(c.collection))
  const enumerated = await Promise.all(
    unscanned.map((c) =>
      readCollectionMintRefsOnchain(c.collection, artist, c.deploy_block).catch(
        () => [] as Array<{ tokenId: string; mintBlock: string }>,
      ),
    ),
  )
  enumerated.forEach((mints, i) => {
    for (const m of mints) {
      if (haveToken.has(`${unscanned[i].collection}:${m.tokenId}`)) continue
      refs.push({
        contract: unscanned[i].collection as `0x${string}`,
        tokenId: m.tokenId,
        creator: artist as `0x${string}`,
        collectionName: null,
        platform: "fnd-collection",
        mintBlock: m.mintBlock,
      })
    }
  })
  return refs
}

/**
 * Enumerate an FND collection clone's mints to its artist — the same
 * Transfer-from-zero semantics the worker scanner uses, as a courtesy
 * read for unadmitted artists. One full-range topic-filtered getLogs
 * per (collection, artist), 24h pgCache; degrades to [] on RPC failure
 * (free-tier providers cap getLogs ranges), which renders as "fewer
 * works shown" rather than an error.
 */
async function readCollectionMintRefsOnchain(
  contract: string,
  artist: string,
  deployBlock: string,
): Promise<Array<{ tokenId: string; mintBlock: string }>> {
  return pgCache(`collection-mints:${contract}:${artist}`, 60 * 60 * 24, async () => {
    const client = getClient()
    const logs = await client.getLogs({
      address: contract as `0x${string}`,
      event: TRANSFER_EVENT,
      args: {
        from: "0x0000000000000000000000000000000000000000",
        to: artist as `0x${string}`,
      },
      fromBlock: BigInt(deployBlock),
      toBlock: "latest",
    })
    return logs
      .filter((l) => l.args.tokenId !== undefined && l.blockNumber !== null)
      .map((l) => ({
        tokenId: l.args.tokenId!.toString(),
        mintBlock: l.blockNumber!.toString(),
      }))
  })
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

const CREATOR_ABI = parseAbi([
  "function tokenCreator(uint256 tokenId) view returns (address)",
  "function owner() view returns (address)",
])

const TRANSFER_EVENT = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
])[0]

type FallbackTransfer = {
  from: string
  to: string
  blockNumber: string
  timestamp: number
  txHash: string
}

/**
 * Courtesy per-token transfer-history fallback for tokens the worker has
 * never scanned (artist outside known_artists). Same role as the tokenURI
 * metadata fallback above: ONE token's own history on demand, not a scan —
 * a single topic-filtered eth_getLogs (from, to, tokenId are all indexed)
 * plus one block-timestamp read per distinct block, capped at the 50 most
 * recent legs to mirror the Postgres path. 6h pgCache: escrowed/idle
 * tokens (the entire unindexed FND set) have frozen history, so steady
 * state is a pg point lookup.
 *
 * Degrades to [] on any RPC failure (free-tier providers cap getLogs
 * ranges) — the page then simply shows no provenance, as it did before.
 */
async function readTokenTransfersOnchain(
  contract: string,
  tokenId: string,
): Promise<FallbackTransfer[]> {
  return pgCache(`token-transfers:${contract}:${tokenId}`, 60 * 60 * 6, async () => {
    const client = getClient()
    const logs = await client.getLogs({
      address: contract as `0x${string}`,
      event: TRANSFER_EVENT,
      args: { tokenId: BigInt(tokenId) },
      fromBlock: 0n,
      toBlock: "latest",
    })
    const recent = logs.slice(-50)
    const tsByBlock = new Map<bigint, number>()
    for (const log of recent) {
      if (log.blockNumber === null || tsByBlock.has(log.blockNumber)) continue
      const block = await client.getBlock({ blockNumber: log.blockNumber })
      tsByBlock.set(log.blockNumber, Number(block.timestamp))
    }
    return recent
      .filter((l) => l.blockNumber !== null && l.args.from && l.args.to)
      .map((l) => ({
        from: l.args.from!.toLowerCase(),
        to: l.args.to!.toLowerCase(),
        blockNumber: l.blockNumber!.toString(),
        timestamp: tsByBlock.get(l.blockNumber!) ?? 0,
        txHash: l.transactionHash ?? "",
      }))
  })
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000"

/**
 * On-chain creator fallback for tokens PND hasn't indexed (artist not in
 * known_artists, contract not in any discovery table). Without this the
 * token page silently drops the artist byline while title/description —
 * which DO have an on-chain fallback via tokenURI — render fine.
 *
 * Ladder: `tokenCreator(tokenId)` first (Foundation shared + collection
 * clones and SuperRare V2 all implement it, and it's per-token correct),
 * then `owner()` (artist-deployed Ownable clones — FND/TL/Manifold/Mint
 * style — where the artist owns the contract). Shared multi-artist
 * contracts all implement tokenCreator, so the owner() rung only fires
 * for single-artist clones where owner ≈ creator.
 *
 * Creator is immutable in practice → 30-day pgCache; at most two
 * eth_calls per unindexed token per month.
 */
async function readTokenCreatorOnchain(
  contract: string,
  tokenId: string,
): Promise<string | null> {
  return pgCache(`token-creator:${contract}:${tokenId}`, 60 * 60 * 24 * 30, async () => {
    const client = getClient()
    try {
      const c = await client.readContract({
        address: contract as `0x${string}`,
        abi: CREATOR_ABI,
        functionName: "tokenCreator",
        args: [BigInt(tokenId)],
      })
      if (c.toLowerCase() !== ZERO_ADDR) return c.toLowerCase()
    } catch {
      // contract doesn't implement tokenCreator — try owner()
    }
    try {
      const o = await client.readContract({
        address: contract as `0x${string}`,
        abi: CREATOR_ABI,
        functionName: "owner",
      })
      if (o.toLowerCase() !== ZERO_ADDR) return o.toLowerCase()
    } catch {
      // not Ownable either — no attribution available
    }
    return null
  })
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
  // Unindexed token (artist outside known_artists, contract in no
  // discovery table): resolve attribution from the chain instead of
  // silently dropping the byline.
  if (!creator) {
    creator = await readTokenCreatorOnchain(c, tokenId).catch(() => null)
  }

  // Unindexed token: no worker-scanned transfer history. Pull the
  // token's own history from the chain (cached courtesy read) so the
  // provenance timeline and owner/escrow line render instead of
  // silently vanishing.
  let chainTransfers: FallbackTransfer[] = []
  if (transfers.length === 0) {
    chainTransfers = await readTokenTransfersOnchain(c, tokenId).catch(() => [])
  }

  if (
    owners.length === 0 &&
    transfers.length === 0 &&
    chainTransfers.length === 0 &&
    !creator
  )
    return null

  const mappedTransfers =
    transfers.length > 0
      ? transfers.map((t) => ({
          from: t.from_addr,
          to: t.to_addr,
          blockNumber: BigInt(t.block_number),
          timestamp: Number(t.block_time),
          txHash: t.tx_hash,
        }))
      : chainTransfers
          .map((t) => ({
            from: t.from,
            to: t.to,
            blockNumber: BigInt(t.blockNumber),
            timestamp: t.timestamp,
            txHash: t.txHash,
          }))
          // getLogs returns oldest-first; the pg path is newest-first
          .reverse()

  return {
    // chainTransfers are oldest-first, so the last one's `to` is the
    // current holder — gives the owner/escrow section a value for
    // unindexed tokens too.
    owner:
      owners[0]?.owner ??
      chainTransfers[chainTransfers.length - 1]?.to ??
      null,
    creator,
    transfers: mappedTransfers,
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

  // Courtesy fill for tokens the worker never warmed (unclaimed artists'
  // seed-discovered works): resolve missing metadata on the spot via
  // resolveTokenMetadataDirect, which writes through to token_metadata —
  // each token resolves once ever, then everyone reads it from Postgres.
  // Bounded: gallery pages call this with ~24 refs; the cap keeps legacy
  // full-array callers from fanning out hundreds of tokenURI+IPFS reads
  // in one render (uncapped remainder fills on subsequent views).
  const MISSING_RESOLVE_CAP = 30
  const RESOLVE_CONCURRENCY = 8
  const missing = refs
    .filter((ref) => {
      const r = byKey.get(`${ref.contract.toLowerCase()}:${ref.tokenId}`)
      return !r || !(r.name || r.description || r.image_url || r.animation_url)
    })
    .slice(0, MISSING_RESOLVE_CAP)
  if (missing.length > 0) {
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(RESOLVE_CONCURRENCY, missing.length) }, async () => {
        while (cursor < missing.length) {
          const ref = missing[cursor++]
          const meta = await resolveTokenMetadataDirect(
            ref.contract,
            ref.tokenId,
          ).catch(() => null)
          if (!meta) continue
          byKey.set(`${ref.contract.toLowerCase()}:${ref.tokenId}`, {
            contract: ref.contract.toLowerCase(),
            token_id: ref.tokenId,
            name: meta.name,
            description: meta.description,
            image_url: meta.image,
            animation_url: meta.animation_url,
            owner:
              byKey.get(`${ref.contract.toLowerCase()}:${ref.tokenId}`)?.owner ??
              null,
          })
        }
      }),
    )
  }

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
