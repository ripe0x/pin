import "server-only"
import { sql } from "./db"

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
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
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
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
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
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
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
  ethSettledWei: bigint
}

/**
 * Aggregate platform totals for the home-page ambient counters.
 * Returns null when the indexer is unavailable; the caller hides the
 * counters sentence entirely in that case.
 */
export async function getPlatformStats(): Promise<PlatformStats | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const [houseRows, settledRows] = await Promise.all([
      db.unsafe(
        `SELECT COUNT(*)::text AS count FROM ${schema}.pnd_houses`,
      ) as Promise<Array<{ count: string }>>,
      db.unsafe(
        `SELECT COALESCE(
            SUM(seller_proceeds + protocol_fee), 0
          )::text AS total
         FROM ${schema}.pnd_auctions
         WHERE status = 'settled'`,
      ) as Promise<Array<{ total: string }>>,
    ])

    return {
      housesDeployed: Number(houseRows[0]?.count ?? 0),
      ethSettledWei: BigInt(settledRows[0]?.total ?? "0"),
    }
  }, 2_000)
}

// ─── Foundation NFTMarket reads ──────────────────────────────────────────
// Backed by `fnd_auctions`, `fnd_bids`, `fnd_buy_nows`, `fnd_sales` —
// populated by the Ponder NFTMarket handlers. All return null when the
// indexer is unavailable / not yet caught up; callers fall back to the
// existing `eth_getLogs`-based RPC paths.

export type FoundationLastSale = {
  priceWei: bigint
  blockTime: number
  source: "auction" | "buyNow"
  txHash: string
}

/**
 * Latest sale (auction-finalized OR buy-now-accepted) for a token.
 */
export async function getFoundationLastSaleFromIndexer(
  nftContract: string,
  tokenId: string,
): Promise<FoundationLastSale | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const contract = nftContract.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT price_wei::text AS price_wei,
              block_time::text AS block_time,
              source,
              tx_hash
       FROM ${schema}.fnd_sales
       WHERE nft_contract = $1
         AND token_id = $2::numeric
       ORDER BY block_time DESC
       LIMIT 1`,
      [contract, tokenId],
    )) as Array<{
      price_wei: string
      block_time: string
      source: "auction" | "buyNow"
      tx_hash: string
    }>

    if (rows.length === 0) return null
    const row = rows[0]
    return {
      priceWei: BigInt(row.price_wei),
      blockTime: Number(row.block_time),
      source: row.source,
      txHash: row.tx_hash,
    }
  })
}

export type FoundationBidHistoryEntry = {
  bidder: string
  amount: bigint
  blockTime: number
  txHash: string
}

/**
 * All bids for a Foundation auction, newest-first.
 */
export async function getFoundationBidHistoryFromIndexer(
  auctionId: string,
): Promise<FoundationBidHistoryEntry[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT bidder, amount::text AS amount,
              block_time::text AS block_time, tx_hash
       FROM ${schema}.fnd_bids
       WHERE auction_id = $1::numeric
       ORDER BY block_number DESC`,
      [auctionId],
    )) as Array<{
      bidder: string
      amount: string
      block_time: string
      tx_hash: string
    }>

    return rows.map((r) => ({
      bidder: r.bidder,
      amount: BigInt(r.amount),
      blockTime: Number(r.block_time),
      txHash: r.tx_hash,
    }))
  })
}

export type FoundationCancellableAuction = {
  auctionId: string
  nftContract: string
  tokenId: string
  reserveWei: bigint
  durationSeconds: number
}

export type FoundationCancellableBuyNow = {
  id: string
  nftContract: string
  tokenId: string
  priceWei: bigint
}

/**
 * Active Foundation listings owned by a seller — cancellable means status =
 * 'active' AND (for auctions) no bids placed yet (highestBid = 0). Replaces
 * the two-`getLogs`-over-10M-blocks scan in `seller-listings.ts`.
 */
export async function getFoundationCancellableListingsFromIndexer(
  sellerAddress: string,
): Promise<{
  auctions: FoundationCancellableAuction[]
  buyNows: FoundationCancellableBuyNow[]
} | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const seller = sellerAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const [auctionRows, buyNowRows] = await Promise.all([
      db.unsafe(
        `SELECT auction_id::text AS auction_id, nft_contract,
                token_id::text AS token_id,
                reserve_price::text AS reserve_price,
                duration_seconds::text AS duration_seconds
         FROM ${schema}.fnd_auctions
         WHERE seller = $1
           AND status = 'active'
           AND highest_bid = 0`,
        [seller],
      ) as Promise<
        Array<{
          auction_id: string
          nft_contract: string
          token_id: string
          reserve_price: string
          duration_seconds: string
        }>
      >,
      db.unsafe(
        `SELECT id, nft_contract, token_id::text AS token_id,
                price::text AS price
         FROM ${schema}.fnd_buy_nows
         WHERE seller = $1
           AND status = 'active'`,
        [seller],
      ) as Promise<
        Array<{
          id: string
          nft_contract: string
          token_id: string
          price: string
        }>
      >,
    ])

    return {
      auctions: auctionRows.map((r) => ({
        auctionId: r.auction_id,
        nftContract: r.nft_contract,
        tokenId: r.token_id,
        reserveWei: BigInt(r.reserve_price),
        durationSeconds: Number(r.duration_seconds),
      })),
      buyNows: buyNowRows.map((r) => ({
        id: r.id,
        nftContract: r.nft_contract,
        tokenId: r.token_id,
        priceWei: BigInt(r.price),
      })),
    }
  })
}

export type FoundationArtistTokenRef = {
  contract: string
  tokenId: string
  blockNumber: bigint
  logIndex: number
}

/**
 * All Foundation tokens (shared 1/1 contract + per-artist collections)
 * minted by a given creator, newest-first. Replaces
 * `discoverSharedContractRefs` and `discoverCollectionRefs` cold-cache
 * `eth_getLogs` scans.
 */
export async function getFoundationArtistTokensFromIndexer(
  artistAddress: string,
): Promise<FoundationArtistTokenRef[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const creator = artistAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT contract, token_id::text AS token_id,
              block_number::text AS block_number, log_index
       FROM ${schema}.fnd_artist_tokens
       WHERE creator = $1
       ORDER BY block_number DESC, log_index DESC`,
      [creator],
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
  }, 2_000)
}

export type FoundationCollectionRef = {
  collection: string
  name: string | null
  kind: "1of1" | "drop"
}

/**
 * Foundation collection contracts deployed by an artist via the V1/V2
 * factories. Replaces the 6-`getLogs`-in-parallel scan in
 * `findArtistCollections`.
 */
export async function getFoundationCollectionsFromIndexer(
  artistAddress: string,
): Promise<FoundationCollectionRef[] | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql

  return withTimeout(async () => {
    const creator = artistAddress.toLowerCase()
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
      /[^a-zA-Z0-9_]/g,
      "",
    )

    const rows = (await db.unsafe(
      `SELECT collection, name, kind
       FROM ${schema}.fnd_collections
       WHERE creator = $1
       ORDER BY created_at_block DESC`,
      [creator],
    )) as Array<{
      collection: string
      name: string | null
      kind: "1of1" | "drop"
    }>

    return rows.map((r) => ({
      collection: r.collection,
      name: r.name,
      kind: r.kind,
    }))
  })
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
    // Ponder namespaces its tables under a configurable schema (set via the
    // DATABASE_SCHEMA env var on the indexer service — currently `ponder`).
    // Default to `ponder` here so the web app and the indexer agree on the
    // location without an extra coordination step. Override with
    // INDEXER_SCHEMA if the indexer's schema name ever changes.
    const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
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
  })
}
