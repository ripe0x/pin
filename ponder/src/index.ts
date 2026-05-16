import { ponder } from "ponder:registry"
import {
  pndAuctions,
  pndBids,
  pndHouses,
  fndArtistTokens,
  fndAuctions,
  fndBids,
  fndBuyNows,
  fndCollections,
  fndSales,
  srv2Auctions,
  tlAuctions,
} from "ponder:schema"
import type { Address } from "viem"

/**
 * Event handlers for every contract Ponder is tracking.
 *
 * Two contract families:
 *
 *   - PND (Sovereign Auction House): factory + clones. Each handler is a
 *     straightforward state-machine write — no derived joins needed.
 *
 *   - FND (Foundation): the shared 1/1 NFT contract, the NFTMarket
 *     marketplace contract, two collection factories, and the per-artist
 *     collection clones discovered via factory pattern. Handlers mirror
 *     the PND shape — auction-created → INSERT, bid → INSERT bid +
 *     UPDATE auction, sale → INSERT sale + UPDATE listing.
 *
 * Bigints are stored natively because Ponder's runtime supports them; the
 * web-app reader hydrates them back from postgres.js as decimal strings.
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

// ─── PND: Sovereign Auction House factory ────────────────────────────────

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
      createdTxHash: event.transaction.hash,
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
    createdTxHash: event.transaction.hash,
  })
})

// Every per-auction update handler below skips silently when the
// auction row is missing. Cause: Ponder 0.16's factory pattern can
// drop a clone out of `ponder_sync.factory_addresses` for a window;
// during that window the clone's `AuctionCreated` log is never
// fetched, so we have no row to update when later events on the same
// auction arrive. Crashing the indexer on the resulting
// `RecordNotFoundError` is much worse than dropping a single update —
// it stops every other auction across every other clone too. Match
// the FND `find-or-skip` pattern (see `NFTMarket:ReserveAuctionBidPlaced`
// below). The drift cron at /api/cron/indexer-drift-check forward-fixes
// the underlying gap; this is the second line of defense for events
// that already slipped through.

ponder.on("SovereignAuctionHouse:AuctionBid", async ({ event, context }) => {
  const { auctionId, bidder, amount, firstBid, extended } = event.args
  const house = event.log.address
  const id = compositeId(house, auctionId)

  // Insert the bid history entry first — even when the auction row is
  // missing the bid is an immutable on-chain event worth preserving.
  // pnd_bids has no FK to pnd_auctions so the insert succeeds either way.
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

  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return

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
    const id = compositeId(house, auctionId)
    const existing = await context.db.find(pndAuctions, { id })
    if (!existing) return
    await context.db.update(pndAuctions, { id }).set({ endTime: newEndTime })
  },
)

ponder.on(
  "SovereignAuctionHouse:AuctionReservePriceUpdated",
  async ({ event, context }) => {
    const { auctionId, reservePrice } = event.args
    const house = event.log.address
    const id = compositeId(house, auctionId)
    const existing = await context.db.find(pndAuctions, { id })
    if (!existing) return
    await context.db.update(pndAuctions, { id }).set({ reservePrice })
  },
)

ponder.on("SovereignAuctionHouse:AuctionEnded", async ({ event, context }) => {
  const { auctionId, winner, sellerProceeds, protocolFee } = event.args
  const house = event.log.address
  const id = compositeId(house, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "settled",
    winner,
    sellerProceeds,
    protocolFee,
    settledAtBlock: event.block.number,
    settledAtTime: event.block.timestamp,
    lifecycleTxHash: event.transaction.hash,
  })
})

ponder.on(
  "SovereignAuctionHouse:AuctionCanceled",
  async ({ event, context }) => {
    const { auctionId } = event.args
    const house = event.log.address
    const id = compositeId(house, auctionId)
    const existing = await context.db.find(pndAuctions, { id })
    if (!existing) return
    await context.db.update(pndAuctions, { id }).set({
      status: "cancelled",
      settledAtBlock: event.block.number,
      settledAtTime: event.block.timestamp,
      lifecycleTxHash: event.transaction.hash,
    })
  },
)

// ─── FND: shared 1/1 contract (FoundationNFT) ────────────────────────────

ponder.on("FoundationNFT:Minted", async ({ event, context }) => {
  const { creator, tokenId } = event.args
  const contract = event.log.address
  await context.db
    .insert(fndArtistTokens)
    .values({
      id: `${contract.toLowerCase()}-${tokenId.toString()}`,
      creator,
      contract,
      tokenId,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      blockTime: event.block.timestamp,
    })
    // Re-orgs occasionally re-emit a settled event; treat as no-op rather
    // than crashing the indexer.
    .onConflictDoNothing()
})

// ─── FND: NFTMarket — reserve auctions ───────────────────────────────────

ponder.on("NFTMarket:ReserveAuctionCreated", async ({ event, context }) => {
  const { seller, nftContract, tokenId, duration, reservePrice, auctionId } =
    event.args
  await context.db.insert(fndAuctions).values({
    auctionId,
    nftContract,
    tokenId,
    seller,
    reservePrice,
    durationSeconds: duration,
    highestBid: 0n,
    highestBidder: null,
    endTime: 0n,
    status: "active",
    createdAtBlock: event.block.number,
    createdAtTime: event.block.timestamp,
  })
})

ponder.on("NFTMarket:ReserveAuctionBidPlaced", async ({ event, context }) => {
  const { auctionId, bidder, amount, endTime } = event.args
  // Skip events whose auction was created pre-startBlock — we never
  // captured the AuctionCreated, so there's nothing to update. Same
  // pattern across every FND update handler below: pre-startBlock
  // listings are out of scope and silently dropped rather than
  // crashing the indexer.
  const auction = await context.db.find(fndAuctions, { auctionId })
  if (!auction) return
  // Bid log is immutable history. Insert first so the row survives even
  // if the auction-state update fails (matches PND behavior).
  await context.db.insert(fndBids).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    auctionId,
    bidder,
    amount,
    endTime,
    blockNumber: event.block.number,
    blockTime: event.block.timestamp,
    txHash: event.transaction.hash,
  })
  await context.db.update(fndAuctions, { auctionId }).set({
    highestBid: amount,
    highestBidder: bidder,
    endTime,
  })
})

ponder.on("NFTMarket:ReserveAuctionFinalized", async ({ event, context }) => {
  const { auctionId, seller, bidder, totalFees, creatorRev, sellerRev } =
    event.args
  // The Finalized event omits nftContract/tokenId — read them from the
  // existing auction row so the fnd_sales row carries the right token.
  const auction = await context.db.find(fndAuctions, { auctionId })
  if (!auction) return // missing on re-org / event ordering edge — skip
  await context.db.update(fndAuctions, { auctionId }).set({
    status: "finalized",
    finalizedTotalFees: totalFees,
    finalizedCreatorRev: creatorRev,
    finalizedSellerRev: sellerRev,
    finalizedAtTime: event.block.timestamp,
    finalizedTxHash: event.transaction.hash,
  })
  await context.db
    .insert(fndSales)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      nftContract: auction.nftContract,
      tokenId: auction.tokenId,
      seller,
      buyer: bidder,
      priceWei: totalFees + creatorRev + sellerRev,
      source: "auction",
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:ReserveAuctionCanceled", async ({ event, context }) => {
  const { auctionId } = event.args
  const auction = await context.db.find(fndAuctions, { auctionId })
  if (!auction) return
  await context.db.update(fndAuctions, { auctionId }).set({
    status: "canceled",
    finalizedAtTime: event.block.timestamp,
    finalizedTxHash: event.transaction.hash,
  })
})

ponder.on("NFTMarket:ReserveAuctionUpdated", async ({ event, context }) => {
  const { auctionId, reservePrice } = event.args
  const auction = await context.db.find(fndAuctions, { auctionId })
  if (!auction) return
  await context.db.update(fndAuctions, { auctionId }).set({ reservePrice })
})

ponder.on(
  "NFTMarket:ReserveAuctionInvalidated",
  async ({ event, context }) => {
    const { auctionId } = event.args
    const auction = await context.db.find(fndAuctions, { auctionId })
    if (!auction) return
    await context.db.update(fndAuctions, { auctionId }).set({
      status: "invalidated",
      finalizedAtTime: event.block.timestamp,
      finalizedTxHash: event.transaction.hash,
    })
  },
)

// ─── FND: NFTMarket — buy now ────────────────────────────────────────────

ponder.on("NFTMarket:BuyPriceSet", async ({ event, context }) => {
  const { nftContract, tokenId, seller, price } = event.args
  const id = `${nftContract.toLowerCase()}-${tokenId.toString()}`
  // Repeated BuyPriceSet for the same (contract, tokenId) overwrites the
  // existing row — the price was updated by the seller. createdAtTime
  // tracks the original listing; updatedAtTime tracks the latest set.
  const existing = await context.db.find(fndBuyNows, { id })
  if (existing) {
    await context.db.update(fndBuyNows, { id }).set({
      seller,
      price,
      status: "active",
      updatedAtTime: event.block.timestamp,
      // Clear acceptance fields on re-list (rare but covers the case
      // where a token was sold-then-re-listed).
      acceptedBuyer: null,
      acceptedTxHash: null,
      acceptedTotalFees: null,
      acceptedCreatorRev: null,
      acceptedSellerRev: null,
    })
  } else {
    await context.db.insert(fndBuyNows).values({
      id,
      nftContract,
      tokenId,
      seller,
      price,
      status: "active",
      createdAtTime: event.block.timestamp,
    })
  }
})

ponder.on("NFTMarket:BuyPriceCanceled", async ({ event, context }) => {
  const { nftContract, tokenId } = event.args
  const id = `${nftContract.toLowerCase()}-${tokenId.toString()}`
  const existing = await context.db.find(fndBuyNows, { id })
  if (!existing) return
  await context.db.update(fndBuyNows, { id }).set({
    status: "canceled",
    updatedAtTime: event.block.timestamp,
  })
})

ponder.on("NFTMarket:BuyPriceAccepted", async ({ event, context }) => {
  const { nftContract, tokenId, seller, buyer, totalFees, creatorRev, sellerRev } =
    event.args
  const id = `${nftContract.toLowerCase()}-${tokenId.toString()}`
  const existing = await context.db.find(fndBuyNows, { id })
  if (existing) {
    await context.db.update(fndBuyNows, { id }).set({
      status: "accepted",
      updatedAtTime: event.block.timestamp,
      acceptedBuyer: buyer,
      acceptedTxHash: event.transaction.hash,
      acceptedTotalFees: totalFees,
      acceptedCreatorRev: creatorRev,
      acceptedSellerRev: sellerRev,
    })
  }
  // Always record the sale even if the BuyPriceSet was pre-startBlock —
  // the sale is itself a valuable event in the activity feed and we have
  // all the fields we need from this event alone (no parent lookup
  // required).
  await context.db
    .insert(fndSales)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      nftContract,
      tokenId,
      seller,
      buyer,
      priceWei: totalFees + creatorRev + sellerRev,
      source: "buyNow",
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:BuyPriceInvalidated", async ({ event, context }) => {
  const { nftContract, tokenId } = event.args
  const id = `${nftContract.toLowerCase()}-${tokenId.toString()}`
  const existing = await context.db.find(fndBuyNows, { id })
  if (!existing) return
  await context.db.update(fndBuyNows, { id }).set({
    status: "invalidated",
    updatedAtTime: event.block.timestamp,
  })
})

// ─── FND: Collection factories (V1 + V2) ─────────────────────────────────

// Both V1 and V2 emit `NFTCollectionCreated` — same indexed shape — so
// each handler does the same INSERT. Inlined twice rather than shared via
// a helper to keep Ponder's generated event-arg types intact at each
// registration site.

ponder.on(
  "NFTCollectionFactoryV1:NFTCollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection,
        creator,
        kind: "1of1",
        name: name || null,
        symbol: symbol || null,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

ponder.on(
  "NFTCollectionFactoryV2:NFTCollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection,
        creator,
        kind: "1of1",
        name: name || null,
        symbol: symbol || null,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

// ─── FND: per-artist collection clones (factory pattern) ─────────────────

// `FoundationCollection:Transfer` fires for every token transfer on every
// clone the factories have spawned. We only care about MINTS (transfers
// from the zero address). The clone's creator is looked up from the
// `fnd_collections` row that was written when the clone was deployed.
ponder.on("FoundationCollection:Transfer", async ({ event, context }) => {
  const { from, tokenId } = event.args
  if (from !== ZERO_ADDRESS) return // only mints
  const collection = event.log.address
  const collectionRow = await context.db.find(fndCollections, { collection })
  if (!collectionRow) return // unexpected — clone untracked

  await context.db
    .insert(fndArtistTokens)
    .values({
      id: `${collection.toLowerCase()}-${tokenId.toString()}`,
      creator: collectionRow.creator,
      contract: collection,
      tokenId,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      blockTime: event.block.timestamp,
    })
    .onConflictDoNothing()
})

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

// Every per-auction update handler below skips silently when the row
// is missing. This happens when the corresponding NewAuction was
// emitted pre-startBlock and our scanner only picked up the later
// lifecycle event. Mirrors the same pattern in the PND handlers
// (see `SovereignAuctionHouse:AuctionBid`) — crashing the indexer on
// a `RecordNotFoundError` here would stop every other auction across
// every other clone too. Pre-startBlock listings are out of scope.

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

  const id = tokenKey(_contractAddress, _tokenId)
  const existing = await context.db.find(srv2Auctions, { id })
  if (!existing) return

  // SR Bazaar's `_newAuctionLength` is the auction duration; the
  // first-bid block timestamp serves as the start time. Subsequent
  // bids carry the same value and we recompute endTime from the
  // current block, matching the contract's late-bid extension.
  const endTime = event.block.timestamp + _newAuctionLength

  await context.db.update(srv2Auctions, { id }).set({
    currentBidWei: _amount,
    currentBidder: _bidder,
    endTime,
  })
})

ponder.on("SuperRareBazaar:AuctionSettled", async ({ event, context }) => {
  const { _contractAddress, _tokenId, _currencyAddress } = event.args
  if (_currencyAddress.toLowerCase() !== ETH_CURRENCY) return
  const id = tokenKey(_contractAddress, _tokenId)
  const existing = await context.db.find(srv2Auctions, { id })
  if (!existing) return
  await context.db.update(srv2Auctions, { id }).set({ status: "settled" })
})

ponder.on("SuperRareBazaar:CancelAuction", async ({ event, context }) => {
  const { _contractAddress, _tokenId } = event.args
  const id = tokenKey(_contractAddress, _tokenId)
  const existing = await context.db.find(srv2Auctions, { id })
  if (!existing) return
  await context.db.update(srv2Auctions, { id }).set({ status: "cancelled" })
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

// Same find-or-skip pattern as the SR V2 handlers above and the PND
// handlers further up: TL lifecycle events whose `ListingConfigured`
// was pre-startBlock won't have a row to update. Skip silently rather
// than crashing the indexer.

ponder.on(
  "TransientAuctionHouse:AuctionBid",
  async ({ event, context }) => {
    const { nftAddress, tokenId, listing } = event.args
    if (listing.currencyAddress.toLowerCase() !== ETH_CURRENCY) return
    const id = tokenKey(nftAddress, tokenId)
    const existing = await context.db.find(tlAuctions, { id })
    if (!existing) return
    // TL stamps `startTime` to first-bid block timestamp on the first
    // bid; subsequent events carry the same startTime. endTime is
    // therefore exact via startTime + duration.
    const endTime = listing.startTime + listing.duration
    await context.db.update(tlAuctions, { id }).set({
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
    const id = tokenKey(nftAddress, tokenId)
    const existing = await context.db.find(tlAuctions, { id })
    if (!existing) return
    await context.db.update(tlAuctions, { id }).set({ status: "settled" })
  },
)

ponder.on(
  "TransientAuctionHouse:BuyNowFulfilled",
  async ({ event, context }) => {
    // Buy-now exits the listing the same way as a settle; the row gets
    // filtered out by `WHERE status='active'` on the read.
    const { nftAddress, tokenId } = event.args
    const id = tokenKey(nftAddress, tokenId)
    const existing = await context.db.find(tlAuctions, { id })
    if (!existing) return
    await context.db.update(tlAuctions, { id }).set({ status: "settled" })
  },
)

ponder.on(
  "TransientAuctionHouse:ListingCanceled",
  async ({ event, context }) => {
    const { nftAddress, tokenId } = event.args
    const id = tokenKey(nftAddress, tokenId)
    const existing = await context.db.find(tlAuctions, { id })
    if (!existing) return
    await context.db.update(tlAuctions, { id }).set({ status: "cancelled" })
  },
)
