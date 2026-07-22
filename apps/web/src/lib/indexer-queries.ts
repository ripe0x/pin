import "server-only"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import { sql } from "./db"
import { surfaceFactory } from "./collection"

/** Foundation NFTMarket address — used as the `[house]` segment for FND auctions. */
const FND_MARKET = NFT_MARKET[MAINNET_CHAIN_ID]

/**
 * Read-side queries against the tables Ponder writes (`pnd_auctions`,
 * `pnd_bids`). Lives next to `pgCache` because both share the same
 * Postgres connection — we don't need a separate GraphQL client.
 *
 * Every export has a hard timeout and returns `null` on miss / failure.
 * Callers fall through to the cached RPC path on null. That makes the
 * indexer additive: when Ponder hasn't synced yet, when the database is
 * unreachable, when we explicitly disable it, the app behaves exactly as
 * it does on the cache+RPC layers.
 *
 * **Kill switch.** Three layers:
 *   1. `DATABASE_URL` unset → `sql` is null → these all return null.
 *   2. `INDEXER_DISABLED=1` → these all return null even when DB is up.
 *   3. Per-query timeout (500ms) → slow indexer reads bail to RPC fallback.
 */

const INDEXER_DISABLED = process.env.INDEXER_DISABLED === "1"

/**
 * Thrown by callers wrapping an indexer read in `unstable_cache` when
 * the read is unavailable (timeout, DB down, kill switch). Throwing
 * — rather than returning `null` from the cached function — keeps
 * `unstable_cache` from persisting the failure, so the next request
 * retries fresh instead of serving the bad value for the full TTL.
 */
export class IndexerUnavailable extends Error {
  constructor(message = "indexer unavailable") {
    super(message)
    this.name = "IndexerUnavailable"
  }
}

// Per-query default; overridable via the `withTimeout` second arg. Home-
// page reads (square + counters) pass 2_000 because they're below the hero
// behind Suspense, where a cold-Postgres-read of ~1s is acceptable; per-
// token reads use this default so a slow indexer can't add latency to the
// primary render.
const QUERY_TIMEOUT_MS = 500

/**
 * Race a query against a timeout. Returns `null` if the query exceeds
 * `timeoutMs` so we don't add latency to renders when the indexer is
 * slow / unreachable / not yet synced.
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Number of active PND auctions (status = 'active') for a given seller.
 * Maps directly to `getActiveAuctionCount` in `apps/web/src/lib/auctions.ts`.
 *
 * Returns `null` if the indexer is unavailable / disabled / slow — the
 * caller treats that as "fall back to RPC".
 */
export type SettledAuctionBid = {
  bidder: string
  bidderDisplay: string
  amount: bigint
  blockTime: number
  txHash: string
}

export type SettledAuction = {
  seller: string
  sellerDisplay: string
  winner: string
  winnerDisplay: string
  amount: bigint
  settledAtTime: number
  bids: SettledAuctionBid[]
}

export async function getSettledAuctionForToken(
  tokenContract: string,
  tokenId: string,
): Promise<SettledAuction | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const contract = tokenContract.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT id, seller, winner, amount::text AS amount,
              settled_at_time::text AS settled_at_time
       FROM ${schema}.pnd_auctions
       WHERE token_contract = $1
         AND token_id = $2::numeric
         AND status = 'settled'
       ORDER BY settled_at_time DESC
       LIMIT 1`,
      [contract, tokenId],
    )) as Array<{
      id: string
      seller: string
      winner: string
      amount: string
      settled_at_time: string
    }>

    if (rows.length === 0) return null
    const row = rows[0]

    const bidRows = (await db.unsafe(
      `SELECT bidder, amount::text AS amount,
              block_time::text AS block_time, tx_hash
       FROM ${schema}.pnd_bids
       WHERE auction_id = $1
       ORDER BY block_number DESC`,
      [row.id],
    )) as Array<{
      bidder: string
      amount: string
      block_time: string
      tx_hash: string
    }>

    return {
      seller: row.seller,
      sellerDisplay: row.seller,
      winner: row.winner ?? "",
      winnerDisplay: row.winner ?? "",
      amount: BigInt(row.amount),
      settledAtTime: Number(row.settled_at_time),
      bids: bidRows.map((b) => ({
        bidder: b.bidder,
        bidderDisplay: b.bidder,
        amount: BigInt(b.amount),
        blockTime: Number(b.block_time),
        txHash: b.tx_hash,
      })),
    }
  })
}

/**
 * One completed auction sale for a token (PND `settled` or FND `finalized`,
 * always with a winner). Powers the merged Provenance timeline on the token
 * page — a token can have many, hence no `LIMIT 1`. `marketAddress` +
 * `auctionId` reconstruct the per-auction page link target.
 */
export type TokenAuctionSale = {
  source: "sovereign" | "foundation"
  marketAddress: string
  auctionId: string
  seller: string
  winner: string
  amountWei: bigint
  settledAtTime: number
  settlementTxHash: string | null
}

/**
 * Every completed sale for a token across PND houses and Foundation, newest
 * first. Pure Postgres (zero RPC); both branches hit the existing
 * `(token_contract, token_id)` / `(nft_contract, token_id)` indexes. Wrapped
 * in `withTimeout` because this is an *additive* read on the hot token render
 * — a slow indexer must not block the page; it just degrades to plain
 * transfers. Returns `[]` on miss / unavailable.
 */
export async function getTokenAuctionSales(
  tokenContract: string,
  tokenId: string,
): Promise<TokenAuctionSale[]> {
  if (INDEXER_DISABLED || !sql) return []
  const db = sql

  const result = await withTimeout(async () => {
    const contract = tokenContract.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    // settled_at stays a bigint (NOT cast to text) so the UNION's final
    // ORDER BY sorts numerically, not lexicographically.
    const rows = (await db.unsafe(
      `(SELECT 'sovereign' AS source, lower(house) AS market,
               auction_id::text AS auction_id,
               lower(seller) AS seller, lower(winner) AS winner,
               (coalesce(seller_proceeds,0) + coalesce(protocol_fee,0))::text AS amount,
               settled_at_time AS settled_at, lifecycle_tx_hash AS tx_hash
        FROM ${schema}.pnd_auctions
        WHERE lower(token_contract) = $1 AND token_id::text = $2
          AND status = 'settled' AND winner IS NOT NULL)
       UNION ALL
       (SELECT 'foundation' AS source, $3 AS market,
               auction_id::text AS auction_id,
               lower(seller) AS seller, lower(highest_bidder) AS winner,
               (coalesce(finalized_total_fees,0) + coalesce(finalized_creator_rev,0)
                + coalesce(finalized_seller_rev,0))::text AS amount,
               finalized_at_time AS settled_at, finalized_tx_hash AS tx_hash
        FROM ${schema}.fnd_auctions
        WHERE lower(nft_contract) = $1 AND token_id::text = $2
          AND status = 'finalized' AND highest_bidder IS NOT NULL)
       ORDER BY settled_at DESC`,
      [contract, tokenId, FND_MARKET.toLowerCase()],
    )) as Array<{
      source: string; market: string; auction_id: string;
      seller: string; winner: string; amount: string;
      settled_at: string; tx_hash: string | null
    }>

    return rows.map((r) => ({
      source: r.source as "sovereign" | "foundation",
      marketAddress: r.market,
      auctionId: r.auction_id,
      seller: r.seller,
      winner: r.winner,
      amountWei: BigInt(r.amount),
      settledAtTime: Number(r.settled_at),
      settlementTxHash: r.tx_hash,
    }))
  })

  return result ?? []
}

export type ActivePndAuction = {
  house: string
  tokenContract: string
  tokenId: string
  seller: string
  amount: bigint
  reservePrice: bigint
  endTime: number
  firstBidTime: number
  createdAtTime: number
}

/**
 * Currently-active PND auctions across every Sovereign Auction House,
 * ordered ending-soonest-first with pre-bid auctions (endTime = 0) at the
 * end. Powers the home-page square.
 */
export async function getActivePndAuctions(
  limit = 12,
): Promise<ActivePndAuction[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  // Longer timeout than the per-token reads: the home-page square renders
  // in a Suspense boundary below the hero, so paying ~700ms-1s on the
  // first uncached load is fine. The hero still streams immediately.
  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT house, token_contract, token_id::text AS token_id, seller,
              amount::text AS amount, reserve_price::text AS reserve_price,
              end_time::text AS end_time,
              first_bid_time::text AS first_bid_time,
              created_at_time::text AS created_at_time
       FROM ${schema}.pnd_auctions
       WHERE status = 'active'
       ORDER BY
         CASE WHEN end_time = 0 THEN 1 ELSE 0 END,
         end_time ASC
       LIMIT $1`,
      [limit],
    )) as Array<{
      house: string
      token_contract: string
      token_id: string
      seller: string
      amount: string
      reserve_price: string
      end_time: string
      first_bid_time: string
      created_at_time: string
    }>

    return rows.map((r) => ({
      house: r.house,
      tokenContract: r.token_contract,
      tokenId: r.token_id,
      seller: r.seller,
      amount: BigInt(r.amount),
      reservePrice: BigInt(r.reserve_price),
      endTime: Number(r.end_time),
      firstBidTime: Number(r.first_bid_time),
      createdAtTime: Number(r.created_at_time),
    }))
  }, 2_000)
}

// REMOVED in v2: getActiveSrV2Auctions, getActiveTlAuctions,
// getMintTokensFromIndexer. The underlying Ponder tables (srv2_auctions,
// tl_auctions, mint_artist_tokens) are dropped from v2's schema.
//
// Active SR V2 / TL auctions: now served by lib/onchain.ts:
//   getActiveSrV2AuctionMap(artist) + getActiveTlAuctionMap(artist).
//   On-demand getLogs(seller=artist), 30s pgCache, only fires on
//   artist-page renders (gated by isCrawler). Trades 30s of staleness
//   for elimination of continuous marketplace indexing.
//
// Mint artist tokens: now served by the worker. Web reads them from
// public.artist_tokens WHERE platform='mint' via lib/reads.ts.
//
// The home-grid orchestration that used to UNION the three sources is
// gone in v2 (home is just the activity feed now).

/**
 * SuperRare V2 tokens minted by `creator` per Ponder. Replaces the
 * web-side `scanSrv2ArtistTokens` + `lazy_srv2_artist_tokens` path.
 * Returns null when the indexer is unavailable/slow.
 */
export type IndexerSrv2TokenRef = {
  contract: string
  tokenId: string
  blockNumber: bigint
  logIndex: number
}

export async function getSrv2TokensFromIndexer(
  creator: string,
): Promise<IndexerSrv2TokenRef[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT contract,
              token_id::text AS token_id,
              block_number::text AS block_number,
              log_index
         FROM ${schema}.srv2_artist_tokens
        WHERE creator = $1
        ORDER BY block_number DESC, log_index DESC`,
      [creator.toLowerCase()],
    )) as Array<{
      contract: string
      token_id: string
      block_number: string
      log_index: number
    }>

    return rows.map((r) => ({
      contract: r.contract,
      tokenId: r.token_id,
      blockNumber: BigInt(r.block_number),
      logIndex: r.log_index,
    }))
  })
}

// REMOVED in v2: getTlTokensFromIndexer. The ponder.tl_artist_tokens
// table is dropped; TL artist tokens are now served by the worker via
// public.artist_tokens WHERE platform='tl'. Web reads them through
// lib/reads.ts:getArtistTokens.

export type PndHouse = {
  house: string
  owner: string
  createdAtTime: number
}

/**
 * Houses deployed through the SovereignAuctionHouseFactory, newest first.
 * Includes houses that have no listings yet — the row is written when the
 * factory emits `AuctionHouseCreated`, before any auction exists.
 */
export async function getPndHouses(limit = 24): Promise<PndHouse[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT house, owner, created_at_time::text AS created_at_time
       FROM ${schema}.pnd_houses
       ORDER BY created_at_time DESC
       LIMIT $1`,
      [limit],
    )) as Array<{ house: string; owner: string; created_at_time: string }>

    return rows.map((r) => ({
      house: r.house,
      owner: r.owner,
      createdAtTime: Number(r.created_at_time),
    }))
  }, 2_000)
}

export type PlatformStats = {
  housesDeployed: number
  collectionsDeployed: number
  /** Auction seller proceeds plus Surface mint revenue net of referral
   * shares — the ETH that reached artists, not gross volume. */
  ethToArtistsWei: bigint
}

/**
 * Aggregate platform totals for the home-page ambient counters.
 * Returns null when the indexer is unavailable; the caller hides the
 * counters sentence entirely in that case.
 *
 * The Surface aggregates (collections count, mint revenue) only run when
 * the factory address resolves: pre-deploy the `collections` /
 * `collection_sales` tables don't exist in the indexer schema, so an
 * unconditional query would error the whole read.
 */
export async function getPlatformStats(): Promise<PlatformStats | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const surfaceLive = surfaceFactory() !== null

    const [houseRows, settledRows, collectionRows, mintNetRows] =
      await Promise.all([
        db.unsafe(
          `SELECT COUNT(*)::text AS count FROM ${schema}.pnd_houses`,
        ) as Promise<Array<{ count: string }>>,
        db.unsafe(
          `SELECT COALESCE(SUM(seller_proceeds), 0)::text AS total
           FROM ${schema}.pnd_auctions
           WHERE status = 'settled'`,
        ) as Promise<Array<{ total: string }>>,
        surfaceLive
          ? (db.unsafe(
              `SELECT COUNT(*)::text AS count FROM ${schema}.collections`,
            ) as Promise<Array<{ count: string }>>)
          : Promise.resolve([{ count: "0" }]),
        surfaceLive
          ? (db.unsafe(
              `SELECT (
                 COALESCE((SELECT SUM(paid) FROM ${schema}.collection_sales), 0)
                 - COALESCE((SELECT SUM(amount) FROM ${schema}.collection_referrals), 0)
               )::text AS total`,
            ) as Promise<Array<{ total: string }>>)
          : Promise.resolve([{ total: "0" }]),
      ])

    return {
      housesDeployed: Number(houseRows[0]?.count ?? 0),
      collectionsDeployed: Number(collectionRows[0]?.count ?? 0),
      ethToArtistsWei:
        BigInt(settledRows[0]?.total ?? "0") +
        BigInt(mintNetRows[0]?.total ?? "0"),
    }
  }, 2_000)
}


// ─── Foundation artist token pre-filter ──────────────────────────────────
//
// Used by `discoverFoundationArtistRefs` to short-circuit the expensive
// 6-call eth_getLogs scan when Ponder already has the answer. Critical
// for crawler protection: search-engine bots walking `/artist/<addr>`
// links from the activity feed used to trigger eager Foundation scans
// against ~13M blocks of chain history per address. With Ponder
// indexing FND, a creator's tokens are a Postgres point lookup.

export type IndexerFoundationTokenRef = {
  contract: string
  tokenId: string
  blockNumber: bigint
  logIndex: number
}

/**
 * Foundation tokens minted by `creator` per Ponder. Returns null when
 * the indexer is unavailable / disabled / slow so callers fall back to
 * the existing lazy + RPC path. Returns `[]` when Ponder is healthy and
 * the creator legitimately has no Foundation tokens since the indexer's
 * startBlock — caller treats `[]` as a positive "I have an answer" hit
 * (skip eager scan).
 *
 * Caveat: Ponder's startBlock is the same as PND's (~Nov 2025). Creators
 * with only pre-startBlock activity will return `[]` here even though
 * they're real Foundation creators. The caller can decide whether to
 * trust the empty answer or fall through to the full eager scan; today
 * the caller chooses to trust it for cost-protection reasons (the
 * lazy_fnd_artist_index_status 30-day TTL on negative answers is
 * preserved for the rare case it's needed).
 */
export async function getFoundationTokensFromIndexer(
  creator: string,
): Promise<IndexerFoundationTokenRef[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT contract,
              token_id::text AS token_id,
              block_number::text AS block_number,
              log_index
         FROM ${schema}.fnd_artist_tokens
        WHERE creator = $1
        ORDER BY block_number DESC, log_index DESC`,
      [creator.toLowerCase()],
    )) as Array<{
      contract: string
      token_id: string
      block_number: string
      log_index: number
    }>

    return rows.map((r) => ({
      contract: r.contract,
      tokenId: r.token_id,
      blockNumber: BigInt(r.block_number),
      logIndex: r.log_index,
    }))
  })
}

// ─── Activity feed ────────────────────────────────────────────────────────
//
// One reverse-chronological stream of "sovereign actions" — events whose
// grammatical subject is the artist (deploy, list, mint, settle), plus
// first-bid events on their auctions. Powers the v2 home page.

export type ActivityKind =
  | "house.deployed"
  | "collection.deployed"
  | "auction.opened"
  | "auction.firstBid"
  | "auction.bid"
  | "auction.settled"
  | "auction.cancelled"
  | "sale.buyNow"
  | "mint"

export type ActivityEvent = {
  id: string
  kind: ActivityKind
  blockTime: number
  /** The address that's the *subject* of the row (seller / deployer / minter). */
  artist: string
  /** The other party, when relevant (winner, bidder, buyer). */
  counterparty: string | null
  tokenContract: string | null
  tokenId: string | null
  amountWei: bigint | null
  reserveWei: bigint | null
  endTime: number | null
  house: string | null
  collection: string | null
  collectionName: string | null
  /** The transaction hash that produced this event, when the indexer
   * stores one. Available for bids, FND sales, and FND auction
   * settlements; `null` for PND settlements / house & collection
   * deployments / mints (those tables don't carry a tx hash today). */
  txHash: string | null
  /** Tokens issued by this event. Surface `Minted` covers a contiguous
   * range per call, so one event can carry quantity > 1; every other
   * source is one token per event (`null`, treated as 1). */
  quantity: number | null
}

/**
 * Recent sovereign actions across both contract families, normalized to a
 * single shape and sorted newest-first. Each subquery is independently
 * bounded with `ORDER BY <time> DESC LIMIT 100` so the merge sorts at most
 * a few hundred rows even before any composite-time index exists.
 *
 * Returns `null` on indexer-unavailable so callers can hide the feed
 * rather than show a half-broken page.
 */
/**
 * Keyset cursor for `getActivityFeed`. The feed sorts by
 * `(blockTime DESC, id DESC)` — events in the same block share a
 * blockTime, so `id` is the tiebreaker. To page, the caller passes
 * the last row's `(blockTime, id)` and we return the next slice.
 *
 * The unioned subquery shape means we can't keyset-paginate inside
 * each branch (each branch has a distinct ORDER BY). Instead we widen
 * `PER_SUBQUERY_LIMIT` per page so the merged candidate pool covers
 * the requested cursor range, then filter+sort+limit at the outer
 * query. For `limit ≤ 50` this stays under a few hundred rows of
 * scan per page.
 */
export type ActivityCursor = {
  blockTime: number
  id: string
}

export async function getActivityFeed(
  limit = 50,
  cursor: ActivityCursor | null = null,
  timeoutMs = 3_000,
): Promise<ActivityEvent[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    type Row = {
      kind: ActivityKind
      id: string
      block_time: string
      artist: string
      counterparty: string | null
      token_contract: string | null
      token_id: string | null
      amount: string | null
      reserve: string | null
      end_time: string | null
      house: string | null
      collection: string | null
      collection_name: string | null
      tx_hash: string | null
      quantity: string | null
    }

    const PER_SUBQUERY_LIMIT = 100

    // Surface branches only exist once the factory is deployed: the
    // collections/collection_mints tables aren't created in the indexer
    // schema before that, and referencing them would error the whole
    // unioned query.
    const surfaceLive = surfaceFactory() !== null

    // Filter listing/cancellation pairs that happened within 15 minutes
    // of each other. Treated as noise (test mints, mistaken listings)
    // rather than signal. Both events filter together so the feed
    // doesn't show one half of the pair.
    const SHORT_LIFE_SECONDS = 900
    const PND_NOT_QUICK_CANCEL = `NOT (status = 'cancelled' AND settled_at_time IS NOT NULL AND settled_at_time - created_at_time < ${SHORT_LIFE_SECONDS})`
    const FND_NOT_QUICK_CANCEL = `NOT (status = 'canceled' AND finalized_at_time IS NOT NULL AND finalized_at_time - created_at_time < ${SHORT_LIFE_SECONDS})`
    const PND_LONG_LIVED_CANCEL = `status = 'cancelled' AND settled_at_time IS NOT NULL AND settled_at_time - created_at_time >= ${SHORT_LIFE_SECONDS}`

    // Hide "minted" rows whose tokenURI is broken. Three states, keyed on
    // the LEFT-JOINed token_metadata row (alias `m`):
    //   - no row yet            → SHOW. Resolution hasn't been attempted;
    //     rendering the row is what triggers the enrichment attempt +
    //     write-through, so hiding it would leave the token unresolved
    //     forever (chicken-and-egg).
    //   - row with any content  → SHOW.
    //   - all-null row + mint older than the grace window → HIDE. The
    //     fetch was attempted and failed; past the window that's a broken
    //     tokenURI, not propagation lag (e.g. FND #133282's
    //     ipfs://https://… double-scheme URI). Dropping the event also
    //     stops the render path from re-resolving the dead URI on every
    //     feed revalidation.
    const MINT_METADATA_GRACE_SECONDS = 3600
    const mintNotBroken = (timeCol: string) =>
      `(m.contract IS NULL
        OR m.name IS NOT NULL OR m.description IS NOT NULL
        OR m.image_url IS NOT NULL OR m.animation_url IS NOT NULL
        OR ${timeCol} > EXTRACT(EPOCH FROM NOW()) - ${MINT_METADATA_GRACE_SECONDS})`

    // Cursor-aware branch filters. Each branch limits to its top-N
    // strictly-older-than-cursor rows; the outer query enforces the
    // (blockTime, id) tiebreak globally. Without the per-branch
    // filter, deep pages would starve branches whose top-100 rows
    // all sit above the cursor.
    const cursorTime = cursor?.blockTime ?? null
    const cursorId = cursor?.id ?? null
    const branchFilter = (timeCol: string) =>
      cursor ? `AND ${timeCol} <= $2::numeric` : ""
    // The settled subquery already has a WHERE clause; everything
    // else needs `WHERE 1=1` as a prefix so we can append AND-clauses
    // unconditionally.
    const where = (existing: string | null, timeCol: string) => {
      const branch = branchFilter(timeCol)
      if (!branch) return existing ? `WHERE ${existing}` : ""
      return existing ? `WHERE ${existing} ${branch}` : `WHERE 1=1 ${branch}`
    }

    const rows = (await db.unsafe(
      `WITH events AS (
         (SELECT
            'house.deployed'::text AS kind,
            ('house:' || house)::text AS id,
            created_at_time::text AS block_time,
            owner::text AS artist,
            NULL::text AS counterparty,
            NULL::text AS token_contract,
            NULL::text AS token_id,
            NULL::text AS amount,
            NULL::text AS reserve,
            NULL::text AS end_time,
            house::text AS house,
            NULL::text AS collection,
            NULL::text AS collection_name,
            created_tx_hash::text AS tx_hash,
            NULL::text AS quantity
          FROM ${schema}.pnd_houses
          ${where(null, "created_at_time")}
          ORDER BY created_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'collection.deployed'::text,
            ('coll:' || collection)::text,
            created_at_time::text,
            creator::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            collection::text,
            name,
            NULL::text,
            NULL::text
          FROM ${schema}.fnd_collections
          ${where(null, "created_at_time")}
          ORDER BY created_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'auction.opened'::text,
            ('pnd-open:' || id)::text,
            created_at_time::text,
            seller::text,
            NULL::text,
            token_contract::text,
            token_id::text,
            NULL::text,
            reserve_price::text,
            NULLIF(end_time, 0)::text,
            house::text,
            NULL::text,
            NULL::text,
            created_tx_hash::text,
            NULL::text
          FROM ${schema}.pnd_auctions
          ${where(PND_NOT_QUICK_CANCEL, "created_at_time")}
          ORDER BY created_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'auction.opened'::text,
            ('fnd-open:' || auction_id)::text,
            created_at_time::text,
            seller::text,
            NULL::text,
            nft_contract::text,
            token_id::text,
            NULL::text,
            reserve_price::text,
            NULLIF(end_time, 0)::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text
          FROM ${schema}.fnd_auctions
          ${where(FND_NOT_QUICK_CANCEL, "created_at_time")}
          ORDER BY created_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'auction.settled'::text,
            ('pnd-settle:' || id)::text,
            settled_at_time::text,
            seller::text,
            winner::text,
            token_contract::text,
            token_id::text,
            amount::text,
            NULL::text,
            NULL::text,
            house::text,
            NULL::text,
            NULL::text,
            lifecycle_tx_hash::text,
            NULL::text
          FROM ${schema}.pnd_auctions
          ${where("status = 'settled' AND settled_at_time IS NOT NULL", "settled_at_time")}
          ORDER BY settled_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'auction.cancelled'::text,
            ('pnd-cancel:' || id)::text,
            settled_at_time::text,
            seller::text,
            NULL::text,
            token_contract::text,
            token_id::text,
            NULL::text,
            reserve_price::text,
            NULL::text,
            house::text,
            NULL::text,
            NULL::text,
            lifecycle_tx_hash::text,
            NULL::text
          FROM ${schema}.pnd_auctions
          ${where(PND_LONG_LIVED_CANCEL, "settled_at_time")}
          ORDER BY settled_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            CASE WHEN source = 'auction'
                 THEN 'auction.settled'
                 ELSE 'sale.buyNow' END,
            ('sale:' || id)::text,
            block_time::text,
            seller::text,
            buyer::text,
            nft_contract::text,
            token_id::text,
            price_wei::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            tx_hash::text,
            NULL::text
          FROM ${schema}.fnd_sales
          ${where(null, "block_time")}
          ORDER BY block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            'mint'::text,
            ('mint:' || t.id)::text,
            t.block_time::text,
            t.creator::text,
            NULL::text,
            t.contract::text,
            t.token_id::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text
          FROM ${schema}.fnd_artist_tokens t
          LEFT JOIN token_metadata m
            ON m.contract = lower(t.contract) AND m.token_id = t.token_id::text
          ${where(mintNotBroken("t.block_time"), "t.block_time")}
          ORDER BY t.block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         -- Mint protocol (mint.vv.xyz) editions. Worker-scanned into
         -- public.artist_tokens (platform='mint'), gated on known_artists. Same
         -- connection reaches public directly; mint_time is the first mint's
         -- block time (precomputed so this branch is a partial-index scan). The
         -- lateral join surfaces the first mint's recipient as the counterparty
         -- (the collector who minted) — the row reads "<minter> minted <token>
         -- by <artist>", with the artist (creator) as the trailing credit. The
         -- lateral is a single indexed lookup per row (token_1155_mints is keyed
         -- on (contract, token_id, block_number)).
         (SELECT
            'mint'::text,
            ('vvmint:' || at.contract || ':' || at.token_id)::text,
            at.mint_time::text,
            at.artist::text,
            fm.to_addr::text,
            at.contract::text,
            at.token_id::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text
          FROM artist_tokens at
          JOIN LATERAL (
            SELECT to_addr
            FROM token_1155_mints tm
            WHERE tm.contract = at.contract AND tm.token_id = at.token_id
            ORDER BY tm.block_number ASC, tm.log_index ASC
            LIMIT 1
          ) fm ON true
          LEFT JOIN token_metadata m
            ON m.contract = lower(at.contract) AND m.token_id = at.token_id
          WHERE at.platform = 'mint' AND at.mint_time IS NOT NULL
            AND ${mintNotBroken("at.mint_time")}
            ${branchFilter("at.mint_time")}
          ORDER BY at.mint_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            (CASE WHEN pb.first_bid THEN 'auction.firstBid'
                  ELSE 'auction.bid' END)::text,
            ('pnd-bid:' || pb.id)::text,
            pb.block_time::text,
            pa.seller::text,
            pb.bidder::text,
            pa.token_contract::text,
            pa.token_id::text,
            pb.amount::text,
            NULL::text,
            NULLIF(pa.end_time, 0)::text,
            pa.house::text,
            NULL::text,
            NULL::text,
            pb.tx_hash::text,
            NULL::text
          FROM ${schema}.pnd_bids pb
          JOIN ${schema}.pnd_auctions pa ON pa.id = pb.auction_id
          ${where(null, "pb.block_time")}
          ORDER BY pb.block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         (SELECT
            (CASE WHEN sub.rn = 1 THEN 'auction.firstBid'
                  ELSE 'auction.bid' END)::text,
            ('fnd-bid:' || sub.id)::text,
            sub.block_time::text,
            fa.seller::text,
            sub.bidder::text,
            fa.nft_contract::text,
            fa.token_id::text,
            sub.amount::text,
            NULL::text,
            NULLIF(sub.end_time, 0)::text,
            NULL::text,
            NULL::text,
            NULL::text,
            sub.tx_hash::text,
            NULL::text
          FROM (
            SELECT id, auction_id, bidder, amount, end_time, block_time, tx_hash,
                   ROW_NUMBER() OVER (
                     PARTITION BY auction_id ORDER BY block_number
                   ) AS rn
            FROM ${schema}.fnd_bids
          ) sub
          JOIN ${schema}.fnd_auctions fa ON fa.auction_id = sub.auction_id
          ${where(null, "sub.block_time")}
          ORDER BY sub.block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})
${
  surfaceLive
    ? `
         UNION ALL

         -- Surface collection deploys. Name/symbol are on the row (from the
         -- SurfaceCreated event), so no contract read is needed to render.
         (SELECT
            'collection.deployed'::text,
            ('surf:' || collection)::text,
            created_at_time::text,
            owner::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            NULL::text,
            collection::text,
            name,
            created_tx_hash::text,
            NULL::text
          FROM ${schema}.collections
          ${where(null, "created_at_time")}
          ORDER BY created_at_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})

         UNION ALL

         -- Surface mints: one row per Minted call (a call can cover a
         -- contiguous range, carried in quantity). Indexed for every
         -- factory-deployed collection regardless of which interface drove
         -- the mint, so self-hosted activity appears here too. The lateral
         -- pulls the canonical minter's Sold record from the same tx for
         -- the paid amount ((collection, block_number) is indexed on
         -- collection_sales); free mints and custom minters have no Sold
         -- row and surface with a null amount.
         (SELECT
            'mint'::text,
            ('surfmint:' || cm.id)::text,
            cm.block_time::text,
            c.owner::text,
            cm."to"::text,
            cm.collection::text,
            cm.first_token_id::text,
            cs.paid::text,
            NULL::text,
            NULL::text,
            NULL::text,
            cm.collection::text,
            c.name,
            cm.tx_hash::text,
            cm.quantity::text
          FROM ${schema}.collection_mints cm
          JOIN ${schema}.collections c ON c.collection = cm.collection
          LEFT JOIN LATERAL (
            SELECT paid
            FROM ${schema}.collection_sales s
            WHERE s.collection = cm.collection
              AND s.block_number = cm.block_number
              AND s.first_token_id = cm.first_token_id
            LIMIT 1
          ) cs ON true
          ${where(null, "cm.block_time")}
          ORDER BY cm.block_time DESC
          LIMIT ${PER_SUBQUERY_LIMIT})`
    : ""
}
       )
       SELECT * FROM events
       ${
         cursor
           ? `WHERE (block_time::numeric < $2::numeric
                     OR (block_time::numeric = $2::numeric AND id < $3))`
           : ""
       }
       ORDER BY block_time::numeric DESC, id DESC
       LIMIT $1`,
      cursor ? [limit, cursorTime, cursorId] : [limit],
    )) as Row[]

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      blockTime: Number(r.block_time),
      artist: r.artist,
      counterparty: r.counterparty,
      tokenContract: r.token_contract,
      tokenId: r.token_id,
      amountWei: r.amount === null ? null : BigInt(r.amount),
      reserveWei: r.reserve === null ? null : BigInt(r.reserve),
      endTime: r.end_time === null ? null : Number(r.end_time),
      house: r.house,
      collection: r.collection,
      collectionName: r.collection_name,
      txHash: r.tx_hash,
      quantity: r.quantity === null ? null : Number(r.quantity),
    }))
  }, timeoutMs)
}

// ─── Dependency-check helpers ────────────────────────────────────────────
//
// Used by `apps/web/src/lib/dependency-check.ts` to assemble the scan
// report at `/api/dependency/[address]`. All four are point lookups
// against existing indexes (`fnd_auctions.seller_status`, `fnd_buy_nows
// .seller_status`, `fnd_artist_tokens.creator`, `fnd_collections.creator`,
// `fnd_sales` filtered on `seller`).

export async function getActiveFndAuctionCount(
  sellerAddress: string,
): Promise<number | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const seller = sellerAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT COUNT(*)::text AS count
         FROM ${schema}.fnd_auctions
        WHERE seller = $1 AND status = 'active'`,
      [seller],
    )) as Array<{ count: string }>
    return Number(rows[0]?.count ?? 0)
  }, 2_000)
}

export async function getActiveFndBuyNowCount(
  sellerAddress: string,
): Promise<number | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const seller = sellerAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT COUNT(*)::text AS count
         FROM ${schema}.fnd_buy_nows
        WHERE seller = $1 AND status = 'active'`,
      [seller],
    )) as Array<{ count: string }>
    return Number(rows[0]?.count ?? 0)
  }, 2_000)
}

export type FoundationCreatorSummary = {
  tokenCount: number
  collectionCount: number
}

/**
 * Counts of Foundation tokens minted by an artist and per-artist
 * collection contracts they've deployed. Combines both contract families
 * (shared FoundationNFT contract + per-artist clones from the V1/V2
 * factories).
 */
export async function getFoundationCreatorSummary(
  artistAddress: string,
): Promise<FoundationCreatorSummary | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const creator = artistAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const [tokenRows, collectionRows] = await Promise.all([
      db.unsafe(
        `SELECT COUNT(*)::text AS count
           FROM ${schema}.fnd_artist_tokens
          WHERE creator = $1`,
        [creator],
      ) as Promise<Array<{ count: string }>>,
      db.unsafe(
        `SELECT COUNT(*)::text AS count
           FROM ${schema}.fnd_collections
          WHERE creator = $1`,
        [creator],
      ) as Promise<Array<{ count: string }>>,
    ])
    return {
      tokenCount: Number(tokenRows[0]?.count ?? 0),
      collectionCount: Number(collectionRows[0]?.count ?? 0),
    }
  }, 2_000)
}

export type FoundationSalesSummary = {
  saleCount: number
  /** True when this seller has any settled Foundation sale on record. */
  hasFoundation: boolean
}

/**
 * Settled Foundation sales (auctions + buy-nows) where this address was
 * the seller. Drives the "sale paths observed" card — Foundation is the
 * one platform PND fully indexes today; the other marketplaces come
 * from the seller-listings adapter in chip 2.
 */
export async function getFoundationSalesSummary(
  sellerAddress: string,
): Promise<FoundationSalesSummary | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const seller = sellerAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT COUNT(*)::text AS count
         FROM ${schema}.fnd_sales
        WHERE seller = $1`,
      [seller],
    )) as Array<{ count: string }>
    const saleCount = Number(rows[0]?.count ?? 0)
    return { saleCount, hasFoundation: saleCount > 0 }
  }, 2_000)
}

export type ArtistContractRow = {
  contract: string
  tokenCount: number
  /** Set when the contract has a row in `fnd_collections` (i.e. it was
   * deployed via the V1/V2 factories). The classifier compares this to
   * the scanned artist address to decide artist-owned vs shared. */
  collectionCreator: string | null
  collectionKind: string | null
  collectionName: string | null
  collectionSymbol: string | null
}

/**
 * Per-contract token counts for an artist, joined with the
 * `fnd_collections` row when one exists. The classifier in
 * `contract-classifier.ts` turns these rows into typed map entries for
 * the Artist Dependency Report.
 *
 * Returns null on indexer-unavailable so the caller can render an
 * "Unable to check" state for the contract-map section rather than
 * failing the whole report.
 */
export async function getArtistContractMap(
  artistAddress: string,
): Promise<ArtistContractRow[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const creator = artistAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT
         t.contract,
         COUNT(*)::int AS token_count,
         c.creator AS collection_creator,
         c.kind   AS collection_kind,
         c.name   AS collection_name,
         c.symbol AS collection_symbol
       FROM ${schema}.fnd_artist_tokens t
       LEFT JOIN ${schema}.fnd_collections c
              ON c.collection = t.contract
       WHERE t.creator = $1
       GROUP BY t.contract, c.creator, c.kind, c.name, c.symbol
       ORDER BY COUNT(*) DESC`,
      [creator],
    )) as Array<{
      contract: string
      token_count: number
      collection_creator: string | null
      collection_kind: string | null
      collection_name: string | null
      collection_symbol: string | null
    }>

    return rows.map((r) => ({
      contract: r.contract,
      tokenCount: Number(r.token_count),
      collectionCreator: r.collection_creator,
      collectionKind: r.collection_kind,
      collectionName: r.collection_name,
      collectionSymbol: r.collection_symbol,
    }))
    // Bigger budget than the other indexer queries because this is the
    // headline read for the dependency report and under pool contention
    // (the orchestrator fires ~6 parallel Postgres calls + the seller-
    // listings adapters' own lazy reads against a max:2 pool) cold
    // queries can queue for >2s before they ever start running.
  }, 4_000)
}

// ─── Catalog ─────────────────────────────────────────────────────────────
//
// Replaces the per-render `viem.multicall` against the Catalog
// contract in `apps/web/src/lib/catalog.ts`. The three reads
// (contracts, tokens, ranges) are point lookups against the per-artist
// composite index on the catalog_* tables, so each query is cheap and
// the three run in parallel.
//
// Returns null when the indexer is disabled / unavailable / slow so the
// caller can fall through to the RPC path. An indexer that's healthy
// but legitimately has no entries for the artist returns an empty
// `Catalog` shape — same semantics as the on-chain getContracts() etc.
// returning empty arrays.
//
// Caveat: Ponder's chain-wide pollingInterval is 300s on mainnet (see
// ponder/ponder.config.ts). A write that confirms now may take up to
// 5 minutes before its event lands in these tables. The
// `useCatalogWrite` hook busts the page caches on tx success — that
// part still works — but the next render against this read can still
// see stale rows during the polling window. If the post-write UX
// becomes a problem, the cheapest fix is to reduce pollingInterval
// (cost rises ~5×) rather than adding a write-time RPC fallback here.

export type IndexerCatalog = {
  contracts: string[]
  tokens: Array<{ contractAddress: string; tokenId: string }>
  tokenRanges: Array<{
    contractAddress: string
    startTokenId: string
    endTokenId: string
  }>
}

export async function getCatalogFromIndexer(
  artistAddress: string,
): Promise<IndexerCatalog | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const artist = artistAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const [contractRows, tokenRows, rangeRows] = await Promise.all([
      db.unsafe(
        `SELECT contract_address
           FROM ${schema}.catalog_contracts
          WHERE artist = $1
          ORDER BY block_number ASC`,
        [artist],
      ) as Promise<Array<{ contract_address: string }>>,
      db.unsafe(
        `SELECT contract_address, token_id::text AS token_id
           FROM ${schema}.catalog_tokens
          WHERE artist = $1
          ORDER BY block_number ASC`,
        [artist],
      ) as Promise<
        Array<{ contract_address: string; token_id: string }>
      >,
      db.unsafe(
        `SELECT contract_address,
                start_token_id::text AS start_token_id,
                end_token_id::text   AS end_token_id
           FROM ${schema}.catalog_ranges
          WHERE artist = $1
          ORDER BY block_number ASC`,
        [artist],
      ) as Promise<
        Array<{
          contract_address: string
          start_token_id: string
          end_token_id: string
        }>
      >,
    ])

    return {
      contracts: contractRows.map((r) => r.contract_address),
      tokens: tokenRows.map((r) => ({
        contractAddress: r.contract_address,
        tokenId: r.token_id,
      })),
      tokenRanges: rangeRows.map((r) => ({
        contractAddress: r.contract_address,
        startTokenId: r.start_token_id,
        endTokenId: r.end_token_id,
      })),
    }
  }, 2_000)
}

export async function getActiveAuctionCountFromIndexer(
  sellerAddress: string,
): Promise<number | null> {
  if (INDEXER_DISABLED || !sql) return null
  // Capture in a non-null local — closures don't narrow `sql`'s nullable
  // type through `withTimeout`'s callback boundary.
  const db = sql

  return withTimeout(async () => {
    // Lower-cased everywhere because Ponder normalizes addresses to
    // lowercase when writing event args (per viem's policy).
    const seller = sellerAddress.toLowerCase()
    // Ponder namespaces its tables under a configurable schema (set via
    // DATABASE_SCHEMA on the indexer service). The convention is to bump
    // the version (`ponder_v1` → `ponder_v2`) on every schema-changing
    // release so the indexer can run zero-downtime cutovers; see
    // ponder/README.md for the full upgrade flow. Override the default
    // here via INDEXER_SCHEMA when the indexer's schema name changes.
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    // Schema name comes from a controlled env var and is sanitized above
    // (postgres.js can't parameterize identifiers, only values), so the
    // unsafe-template usage is fine here.
    const rows = (await db.unsafe(
      `SELECT COUNT(*)::text AS count
       FROM ${schema}.pnd_auctions
       WHERE seller = $1 AND status = 'active'`,
      [seller],
    )) as Array<{ count: string }>

    return Number(rows[0]?.count ?? 0)
  }, 2_000)
}

// ─── PND Surface System (contracts/src/surface/) ─────────────────────────
//
// The collection-to-primary-minter binding (primary minter discovery, docs/
// pnd-surface-thin-token-rearchitecture.md §3.5): a live primaryMinter()
// read exists on the token, but the indexed row (seeded from
// SurfaceCreated, kept current by PrimaryMinterSet) gives the same value
// without an RPC call, so this is the source used. Returns null when the
// indexer doesn't have a row yet (not synced, disabled, unavailable) or
// when the collection has no primary minter set (bring-your-own minter that
// skipped it, or explicitly cleared; column is NULL onchain too). Callers
// treat null as "no primary minter": lib/collection-onchain.ts's
// getCollection() sets `primaryMinter`/`sale` to null rather than guessing.
export async function getCollectionPrimaryMinterFromIndexer(
  collection: string,
): Promise<string | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  return withTimeout(async () => {
    const addr = collection.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )
    const rows = (await db.unsafe(
      `SELECT primary_minter FROM ${schema}.collections WHERE collection = $1 LIMIT 1`,
      [addr],
    )) as Array<{ primary_minter: string | null }>
    return rows[0]?.primary_minter ?? null
  })
}
