import { ponder } from "ponder:registry"
import {
  pndAuctions,
  pndBids,
  pndHouses,
  srv2Auctions,
  tlAuctions,
} from "ponder:schema"
import type { Address } from "viem"

// Note: schema also defines fnd_* tables (auctions, bids, buy_nows, sales,
// collections, artist_tokens). Those are written by the lazy backfill
// routes in apps/web — server-side scans triggered on first cache miss
// per artist/token. Ponder doesn't index Foundation contracts directly:
// eager Layer-1 indexing of NFTMarket/FoundationNFT/factories would
// require a multi-hour backfill from block 11.9M and isn't aligned with
// the lazy strategy.

/**
 * Event handlers for every contract Ponder is tracking. Each handler is a
 * straightforward state-machine write — no derived joins or cross-event
 * lookups needed. Bigints are stored natively because Ponder's runtime
 * supports them; the web-app reader hydrates them back from the GraphQL
 * client.
 *
 * The factory contract (SovereignAuctionHouseFactory) emits
 * `AuctionHouseCreated`. Ponder uses that event implicitly via the
 * `factory()` pattern in ponder.config.ts to discover new clones, and we
 * also write a row per house so callers can list houses without scanning
 * `pnd_auctions` (which misses houses with no listings yet).
 */

const compositeId = (house: string, auctionId: bigint) =>
  `${house.toLowerCase()}-${auctionId.toString()}`

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

ponder.on(
  "SovereignAuctionHouseFactory:AuctionHouseCreated",
  async ({ event, context }) => {
    const { owner, house, feeRecipient, protocolFeeBps } = event.args
    await context.db.insert(pndHouses).values({
      house,
      owner,
      feeRecipient,
      protocolFeeBps,
      createdAtBlock: event.block.number,
      createdAtTime: event.block.timestamp,
    })
  },
)

ponder.on("SovereignAuctionHouse:AuctionCreated", async ({ event, context }) => {
  const { auctionId, tokenId, tokenContract, duration, reservePrice, tokenOwner } =
    event.args
  const house = event.log.address

  await context.db.insert(pndAuctions).values({
    id: compositeId(house, auctionId),
    house,
    auctionId,
    tokenContract,
    tokenId,
    seller: tokenOwner,
    reservePrice,
    duration,
    amount: 0n,
    bidder: ZERO_ADDRESS,
    firstBidTime: 0n,
    endTime: 0n,
    status: "active",
    createdAtBlock: event.block.number,
    createdAtTime: event.block.timestamp,
  })
})

ponder.on("SovereignAuctionHouse:AuctionBid", async ({ event, context }) => {
  const { auctionId, bidder, amount, firstBid, extended } = event.args
  const house = event.log.address
  const id = compositeId(house, auctionId)

  // Insert the bid history entry first; if the auction row update fails for
  // any reason, we still have the immutable record on disk.
  await context.db.insert(pndBids).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    auctionId: id,
    bidder,
    amount,
    blockNumber: event.block.number,
    blockTime: event.block.timestamp,
    txHash: event.transaction.hash,
    firstBid,
    extended,
  })

  // Update live auction state. We need the row's existing `firstBidTime`
  // and `duration` to compute `endTime` correctly when this is *not* the
  // first bid (extension) — Ponder's `update` lets us pass a function that
  // receives the current row.
  await context.db.update(pndAuctions, { id }).set((row) => {
    const firstBidTime = firstBid ? event.block.timestamp : row.firstBidTime
    // endTime = firstBidTime + duration, possibly extended on late bids.
    // The contract's own AuctionEndTimeUpdated event handler below
    // overwrites this if the late-bid extension applied.
    const endTime = firstBid
      ? firstBidTime + row.duration
      : extended
        ? row.endTime // will be corrected by AuctionEndTimeUpdated
        : row.endTime
    return {
      amount,
      bidder,
      firstBidTime,
      endTime,
    }
  })
})

ponder.on(
  "SovereignAuctionHouse:AuctionEndTimeUpdated",
  async ({ event, context }) => {
    const { auctionId, newEndTime } = event.args
    const house = event.log.address
    await context.db
      .update(pndAuctions, { id: compositeId(house, auctionId) })
      .set({ endTime: newEndTime })
  },
)

ponder.on(
  "SovereignAuctionHouse:AuctionReservePriceUpdated",
  async ({ event, context }) => {
    const { auctionId, reservePrice } = event.args
    const house = event.log.address
    await context.db
      .update(pndAuctions, { id: compositeId(house, auctionId) })
      .set({ reservePrice })
  },
)

ponder.on("SovereignAuctionHouse:AuctionEnded", async ({ event, context }) => {
  const { auctionId, winner, sellerProceeds, protocolFee } = event.args
  const house = event.log.address
  await context.db
    .update(pndAuctions, { id: compositeId(house, auctionId) })
    .set({
      status: "settled",
      winner,
      sellerProceeds,
      protocolFee,
      settledAtBlock: event.block.number,
      settledAtTime: event.block.timestamp,
    })
})

ponder.on(
  "SovereignAuctionHouse:AuctionCanceled",
  async ({ event, context }) => {
    const { auctionId } = event.args
    const house = event.log.address
    await context.db
      .update(pndAuctions, { id: compositeId(house, auctionId) })
      .set({
        status: "cancelled",
        settledAtBlock: event.block.number,
        settledAtTime: event.block.timestamp,
      })
  },
)

// ─── SuperRare V2 Bazaar ─────────────────────────────────────────────────
// Single shared marketplace; each auction keyed by (contract, tokenId).
// `creator` is resolved at NewAuction-insert via tokenCreator(tokenId)
// on the originating NFT contract — drives the home-grid artist-seller
// filter. Failures (non-SR-Spaces tokens that don't implement the
// interface) leave creator=null; those rows are filtered out at read.

const tokenCreatorAbi = [
  {
    type: "function",
    name: "tokenCreator",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const

const ownerAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const

const ETH_CURRENCY = "0x0000000000000000000000000000000000000000" as const

const tokenKey = (contract: string, tokenId: bigint) =>
  `${contract.toLowerCase()}-${tokenId.toString()}`

ponder.on("SuperRareBazaar:NewAuction", async ({ event, context }) => {
  const {
    _contractAddress,
    _tokenId,
    _auctionCreator,
    _currencyAddress,
    _minimumBid,
  } = event.args
  // Skip ERC-20 auctions; the web app surfaces ETH-only.
  if (_currencyAddress.toLowerCase() !== ETH_CURRENCY) return

  const creator = await context.client
    .readContract({
      address: _contractAddress,
      abi: tokenCreatorAbi,
      functionName: "tokenCreator",
      args: [_tokenId],
    })
    .catch(() => null)

  await context.db
    .insert(srv2Auctions)
    .values({
      id: tokenKey(_contractAddress, _tokenId),
      contract: _contractAddress,
      tokenId: _tokenId,
      seller: _auctionCreator,
      reserveWei: _minimumBid,
      currentBidWei: 0n,
      currentBidder: null,
      endTime: 0n,
      status: "active",
      creator: (creator as Address | null) ?? null,
      createdAtBlock: event.block.number,
      createdAtTime: event.block.timestamp,
    })
    // The same token can be re-listed after a previous settle/cancel.
    // Replace the row so the new auction's state is authoritative.
    .onConflictDoUpdate({
      seller: _auctionCreator,
      reserveWei: _minimumBid,
      currentBidWei: 0n,
      currentBidder: null,
      endTime: 0n,
      status: "active",
      creator: (creator as Address | null) ?? null,
      createdAtBlock: event.block.number,
      createdAtTime: event.block.timestamp,
    })
})

ponder.on("SuperRareBazaar:AuctionBid", async ({ event, context }) => {
  const {
    _contractAddress,
    _tokenId,
    _bidder,
    _currencyAddress,
    _amount,
    _newAuctionLength,
  } = event.args
  if (_currencyAddress.toLowerCase() !== ETH_CURRENCY) return

  // SR Bazaar's `_newAuctionLength` is the auction duration; the
  // first-bid block timestamp serves as the start time. Subsequent
  // bids carry the same value and we recompute endTime from the
  // current block, matching the contract's late-bid extension.
  const endTime = event.block.timestamp + _newAuctionLength

  await context.db
    .update(srv2Auctions, { id: tokenKey(_contractAddress, _tokenId) })
    .set({
      currentBidWei: _amount,
      currentBidder: _bidder,
      endTime,
    })
})

ponder.on("SuperRareBazaar:AuctionSettled", async ({ event, context }) => {
  const { _contractAddress, _tokenId, _currencyAddress } = event.args
  if (_currencyAddress.toLowerCase() !== ETH_CURRENCY) return
  await context.db
    .update(srv2Auctions, { id: tokenKey(_contractAddress, _tokenId) })
    .set({ status: "settled" })
})

ponder.on("SuperRareBazaar:CancelAuction", async ({ event, context }) => {
  const { _contractAddress, _tokenId } = event.args
  await context.db
    .update(srv2Auctions, { id: tokenKey(_contractAddress, _tokenId) })
    .set({ status: "cancelled" })
})

// ─── Transient Labs Auction House ────────────────────────────────────────
// Custodies the NFT during a live listing. The Listing tuple in every
// event carries the full live state, so handlers don't need follow-up
// reads except for the per-token creator backfill on insert.

ponder.on(
  "TransientAuctionHouse:ListingConfigured",
  async ({ event, context }) => {
    const { nftAddress, tokenId, listing } = event.args
    if (listing.currencyAddress.toLowerCase() !== ETH_CURRENCY) return

    // ERC721TL exposes tokenCreator; older clones fall back to owner()
    // (factory-deployed clones own = artist by Universal Deployer
    // convention).
    const creator = await context.client
      .readContract({
        address: nftAddress,
        abi: tokenCreatorAbi,
        functionName: "tokenCreator",
        args: [tokenId],
      })
      .catch(() =>
        context.client
          .readContract({
            address: nftAddress,
            abi: ownerAbi,
            functionName: "owner",
            args: [],
          })
          .catch(() => null),
      )

    const values = {
      id: tokenKey(nftAddress, tokenId),
      contract: nftAddress,
      tokenId,
      seller: listing.seller,
      reserveWei: listing.reservePrice,
      currentBidWei: 0n,
      currentBidder: null,
      // Pre-bid: startTime is 0n; endTime stays 0n until first bid.
      endTime: 0n,
      status: "active",
      listingType: listing.type_,
      creator: (creator as Address | null) ?? null,
      createdAtBlock: event.block.number,
      createdAtTime: event.block.timestamp,
    } as const
    await context.db.insert(tlAuctions).values(values).onConflictDoUpdate({
      seller: values.seller,
      reserveWei: values.reserveWei,
      currentBidWei: values.currentBidWei,
      currentBidder: values.currentBidder,
      endTime: values.endTime,
      status: values.status,
      listingType: values.listingType,
      creator: values.creator,
      createdAtBlock: values.createdAtBlock,
      createdAtTime: values.createdAtTime,
    })
  },
)

ponder.on(
  "TransientAuctionHouse:AuctionBid",
  async ({ event, context }) => {
    const { nftAddress, tokenId, listing } = event.args
    if (listing.currencyAddress.toLowerCase() !== ETH_CURRENCY) return
    // TL stamps `startTime` to first-bid block timestamp on the first
    // bid; subsequent events carry the same startTime. endTime is
    // therefore exact via startTime + duration.
    const endTime = listing.startTime + listing.duration
    await context.db
      .update(tlAuctions, { id: tokenKey(nftAddress, tokenId) })
      .set({
        currentBidWei: listing.highestBid,
        currentBidder: listing.highestBidder,
        endTime,
      })
  },
)

ponder.on(
  "TransientAuctionHouse:AuctionSettled",
  async ({ event, context }) => {
    const { nftAddress, tokenId } = event.args
    await context.db
      .update(tlAuctions, { id: tokenKey(nftAddress, tokenId) })
      .set({ status: "settled" })
  },
)

ponder.on(
  "TransientAuctionHouse:BuyNowFulfilled",
  async ({ event, context }) => {
    // Buy-now exits the listing the same way as a settle; the row gets
    // filtered out by `WHERE status='active'` on the read.
    const { nftAddress, tokenId } = event.args
    await context.db
      .update(tlAuctions, { id: tokenKey(nftAddress, tokenId) })
      .set({ status: "settled" })
  },
)

ponder.on(
  "TransientAuctionHouse:ListingCanceled",
  async ({ event, context }) => {
    const { nftAddress, tokenId } = event.args
    await context.db
      .update(tlAuctions, { id: tokenKey(nftAddress, tokenId) })
      .set({ status: "cancelled" })
  },
)
