import { ponder } from "@/generated"
import { graphql } from "@ponder/core"
import { erc721Abi } from "@pin/abi"
import { ipfsToHttp } from "@pin/shared"
import * as schema from "../ponder.schema"

// ─── GraphQL API ──────────────────────────────────────────────────────────────

ponder.use("/graphql", graphql())

async function resolveMetadata(
  client: any,
  contract: `0x${string}`,
  tokenId: bigint,
): Promise<{ tokenUri: string; metadata: any; mediaUri: string | null } | null> {
  try {
    const tokenUri = await client.readContract({
      address: contract,
      abi: erc721Abi,
      functionName: "tokenURI",
      args: [tokenId],
    }) as string

    if (!tokenUri) return null

    const httpUrl = ipfsToHttp(tokenUri)
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { tokenUri, metadata: null, mediaUri: null }

    const metadata = await res.json()
    const mediaUri = metadata.image ? ipfsToHttp(metadata.image) : null

    return { tokenUri, metadata, mediaUri }
  } catch {
    return null
  }
}

// ─── Token discovery ─────────────────────────────────────────────────────────
// Ensure a token record exists when we see it in marketplace events.
// Uses onConflictDoNothing so metadata is only resolved once per token.

async function ensureToken(
  db: any,
  chainId: number,
  contract: `0x${string}`,
  tokenId: bigint,
  creator: `0x${string}` | null,
  blockTimestamp: bigint,
) {
  const tokenPk = `${chainId}:${contract}:${tokenId}`

  // Insert minimal record — metadata is resolved lazily by the web app.
  // This keeps indexing fast (no RPC + IPFS round-trips per event).
  await db
    .insert(schema.tokens)
    .values({
      id: tokenPk,
      chainId,
      contract,
      tokenId,
      creator,
      owner: creator,
      tokenUri: null,
      metadata: null,
      mediaUri: null,
      createdAt: blockTimestamp,
    })
    .onConflictDoNothing()
}

// ─── Reserve Auctions ─────────────────────────────────────────────────────────

ponder.on("NFTMarket:ReserveAuctionCreated", async ({ event, context }) => {
  const { db } = context
  const { seller, nftContract, tokenId, reservePrice, auctionId } = event.args
  const chainId = context.network.chainId

  // Discover token if not yet tracked
  await ensureToken(db, chainId, nftContract, tokenId, seller, BigInt(event.block.timestamp))

  await db
    .insert(schema.auctions)
    .values({
      id: auctionId,
      chainId,
      contract: nftContract,
      tokenId,
      seller,
      reservePrice,
      highestBid: 0n,
      highestBidder: undefined,
      endTime: 0n,
      status: "active",
      txCreate: event.transaction.hash,
    })
    .onConflictDoNothing()

  await db
    .insert(schema.listings)
    .values({
      id: `${chainId}:auction:${auctionId}`,
      chainId,
      contract: nftContract,
      tokenId,
      kind: "reserveAuction",
      seller,
      price: reservePrice,
      status: "active",
      createdAt: BigInt(event.block.timestamp),
    })
    .onConflictDoNothing()

  await db
    .insert(schema.processedTxs)
    .values({ txHash: event.transaction.hash, blockNumber: event.block.number })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:ReserveAuctionBidPlaced", async ({ event, context }) => {
  const { db } = context
  const { auctionId, bidder, amount, endTime } = event.args

  // Guard: auction may predate our indexing window
  const auction = await db.find(schema.auctions, { id: auctionId })
  if (auction) {
    await db
      .update(schema.auctions, { id: auctionId })
      .set({
        highestBid: amount,
        highestBidder: bidder,
        endTime,
      })
  }

  await db
    .insert(schema.bids)
    .values({
      id: `${event.transaction.hash}:${event.log.logIndex}`,
      auctionId,
      bidder,
      amount,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      txHash: event.transaction.hash,
      blockTime: BigInt(event.block.timestamp),
    })
    .onConflictDoNothing()

  await db
    .insert(schema.processedTxs)
    .values({ txHash: event.transaction.hash, blockNumber: event.block.number })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:ReserveAuctionFinalized", async ({ event, context }) => {
  const { db } = context
  const { auctionId, seller, bidder, amount } = event.args
  const chainId = context.network.chainId

  const auction = await db.find(schema.auctions, { id: auctionId })

  if (auction) {
    await db.update(schema.auctions, { id: auctionId }).set({
      status: "finalized",
      txFinalize: event.transaction.hash,
    })

    await db
      .insert(schema.sales)
      .values({
        id: `${event.transaction.hash}:${event.log.logIndex}`,
        chainId,
        contract: auction.contract,
        tokenId: auction.tokenId,
        seller,
        buyer: bidder,
        amount,
        source: "auction",
        txHash: event.transaction.hash,
        blockTime: BigInt(event.block.timestamp),
      })
      .onConflictDoNothing()

    // Update listing status
    const listing = await db.find(schema.listings, { id: `${chainId}:auction:${auctionId}` })
    if (listing) {
      await db
        .update(schema.listings, { id: `${chainId}:auction:${auctionId}` })
        .set({ status: "sold", updatedAt: BigInt(event.block.timestamp) })
    }
  }

  await db
    .insert(schema.processedTxs)
    .values({ txHash: event.transaction.hash, blockNumber: event.block.number })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:ReserveAuctionCanceled", async ({ event, context }) => {
  const { db } = context
  const { auctionId } = event.args
  const chainId = context.network.chainId

  // Guard: auction may predate our indexing window
  const auction = await db.find(schema.auctions, { id: auctionId })
  if (auction) {
    await db.update(schema.auctions, { id: auctionId }).set({
      status: "canceled",
    })
  }

  const listing = await db.find(schema.listings, { id: `${chainId}:auction:${auctionId}` })
  if (listing) {
    await db
      .update(schema.listings, { id: `${chainId}:auction:${auctionId}` })
      .set({ status: "canceled", updatedAt: BigInt(event.block.timestamp) })
  }

  await db
    .insert(schema.processedTxs)
    .values({ txHash: event.transaction.hash, blockNumber: event.block.number })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:ReserveAuctionUpdated", async ({ event, context }) => {
  const { db } = context
  const { auctionId, reservePrice } = event.args

  const auction = await db.find(schema.auctions, { id: auctionId })
  if (auction) {
    await db.update(schema.auctions, { id: auctionId }).set({
      reservePrice,
    })
  }
})

ponder.on("NFTMarket:ReserveAuctionInvalidated", async ({ event, context }) => {
  const { db } = context
  const { auctionId } = event.args
  const chainId = context.network.chainId

  const auction = await db.find(schema.auctions, { id: auctionId })
  if (auction) {
    await db.update(schema.auctions, { id: auctionId }).set({
      status: "invalidated",
    })
  }

  const listing = await db.find(schema.listings, { id: `${chainId}:auction:${auctionId}` })
  if (listing) {
    await db
      .update(schema.listings, { id: `${chainId}:auction:${auctionId}` })
      .set({ status: "invalidated", updatedAt: BigInt(event.block.timestamp) })
  }
})

// ─── Buy Now ──────────────────────────────────────────────────────────────────

ponder.on("NFTMarket:BuyPriceSet", async ({ event, context }) => {
  const { db } = context
  const { nftContract, tokenId, seller, price } = event.args
  const chainId = context.network.chainId

  // Discover token if not yet tracked
  await ensureToken(db, chainId, nftContract, tokenId, seller, BigInt(event.block.timestamp))

  const listingId = `${chainId}:buyNow:${nftContract}:${tokenId}`

  await db
    .insert(schema.listings)
    .values({
      id: listingId,
      chainId,
      contract: nftContract,
      tokenId,
      kind: "buyNow",
      seller,
      price,
      status: "active",
      createdAt: BigInt(event.block.timestamp),
    })
    .onConflictDoUpdate({
      price,
      seller,
      status: "active",
      updatedAt: BigInt(event.block.timestamp),
    })

  await db
    .insert(schema.processedTxs)
    .values({ txHash: event.transaction.hash, blockNumber: event.block.number })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:BuyPriceCanceled", async ({ event, context }) => {
  const { db } = context
  const { nftContract, tokenId } = event.args
  const chainId = context.network.chainId

  const listingId = `${chainId}:buyNow:${nftContract}:${tokenId}`
  const listing = await db.find(schema.listings, { id: listingId })
  if (listing) {
    await db
      .update(schema.listings, { id: listingId })
      .set({ status: "canceled", updatedAt: BigInt(event.block.timestamp) })
  }
})

ponder.on("NFTMarket:BuyPriceAccepted", async ({ event, context }) => {
  const { db } = context
  const { nftContract, tokenId, seller, buyer } = event.args
  const chainId = context.network.chainId

  // Discover token if not yet tracked
  await ensureToken(db, chainId, nftContract, tokenId, seller, BigInt(event.block.timestamp))

  const listingId = `${chainId}:buyNow:${nftContract}:${tokenId}`
  const listing = await db.find(schema.listings, { id: listingId })

  if (listing) {
    await db
      .update(schema.listings, { id: listingId })
      .set({ status: "sold", updatedAt: BigInt(event.block.timestamp) })
  }

  await db
    .insert(schema.sales)
    .values({
      id: `${event.transaction.hash}:${event.log.logIndex}`,
      chainId,
      contract: nftContract,
      tokenId,
      seller,
      buyer,
      amount: listing?.price ?? 0n,
      source: "buyNow",
      txHash: event.transaction.hash,
      blockTime: BigInt(event.block.timestamp),
    })
    .onConflictDoNothing()

  await db
    .insert(schema.processedTxs)
    .values({ txHash: event.transaction.hash, blockNumber: event.block.number })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:BuyPriceInvalidated", async ({ event, context }) => {
  const { db } = context
  const { nftContract, tokenId } = event.args
  const chainId = context.network.chainId

  const listingId = `${chainId}:buyNow:${nftContract}:${tokenId}`
  const listing = await db.find(schema.listings, { id: listingId })
  if (listing) {
    await db
      .update(schema.listings, { id: listingId })
      .set({ status: "invalidated", updatedAt: BigInt(event.block.timestamp) })
  }
})

// ─── Offers ───────────────────────────────────────────────────────────────────

ponder.on("NFTMarket:OfferMade", async ({ event, context }) => {
  const { db } = context
  const { nftContract, tokenId, buyer, amount, expiration } = event.args
  const chainId = context.network.chainId

  await db
    .insert(schema.offers)
    .values({
      id: `${chainId}:${nftContract}:${tokenId}:${buyer}`,
      chainId,
      contract: nftContract,
      tokenId,
      buyer,
      amount,
      expiresAt: expiration,
      status: "active",
    })
    .onConflictDoUpdate({
      amount,
      expiresAt: expiration,
      status: "active",
    })

  await db
    .insert(schema.processedTxs)
    .values({ txHash: event.transaction.hash, blockNumber: event.block.number })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:OfferAccepted", async ({ event, context }) => {
  const { db } = context
  const { nftContract, tokenId, buyer, seller } = event.args
  const chainId = context.network.chainId

  // Discover token if not yet tracked
  await ensureToken(db, chainId, nftContract, tokenId, seller, BigInt(event.block.timestamp))

  const offerId = `${chainId}:${nftContract}:${tokenId}:${buyer}`
  const offer = await db.find(schema.offers, { id: offerId })

  if (offer) {
    await db
      .update(schema.offers, { id: offerId })
      .set({ status: "accepted" })
  }

  await db
    .insert(schema.sales)
    .values({
      id: `${event.transaction.hash}:${event.log.logIndex}`,
      chainId,
      contract: nftContract,
      tokenId,
      seller,
      buyer,
      amount: offer?.amount ?? 0n,
      source: "offer",
      txHash: event.transaction.hash,
      blockTime: BigInt(event.block.timestamp),
    })
    .onConflictDoNothing()

  await db
    .insert(schema.processedTxs)
    .values({ txHash: event.transaction.hash, blockNumber: event.block.number })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:OfferCanceled", async ({ event, context }) => {
  const { db } = context
  const { nftContract, tokenId, buyer } = event.args
  const chainId = context.network.chainId

  const offerId = `${chainId}:${nftContract}:${tokenId}:${buyer}`
  const offer = await db.find(schema.offers, { id: offerId })
  if (offer) {
    await db
      .update(schema.offers, { id: offerId })
      .set({ status: "canceled" })
  }
})

ponder.on("NFTMarket:OfferInvalidated", async ({ event, context }) => {
  // OfferInvalidated doesn't include buyer — we can't target a specific offer.
  // Skipped: in practice, invalidation events are rare and this is a known limitation.
})

// ─── ERC-721 Transfers (FoundationNFT) ────────────────────────────────────────

ponder.on("FoundationNFT:Transfer", async ({ event, context }) => {
  const { db } = context
  const { from, to, tokenId } = event.args
  const chainId = context.network.chainId
  const contract = event.log.address

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

  // Record transfer
  await db
    .insert(schema.transfers)
    .values({
      id: `${event.transaction.hash}:${event.log.logIndex}`,
      chainId,
      contract,
      tokenId,
      from,
      to,
      blockTime: BigInt(event.block.timestamp),
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
    })
    .onConflictDoNothing()

  const tokenPk = `${chainId}:${contract}:${tokenId}`

  if (from === ZERO_ADDRESS) {
    // Mint — resolve metadata from tokenURI
    const meta = await resolveMetadata(context.client, contract, tokenId)

    await db
      .insert(schema.tokens)
      .values({
        id: tokenPk,
        chainId,
        contract,
        tokenId,
        creator: to,
        owner: to,
        tokenUri: meta?.tokenUri ?? null,
        metadata: meta?.metadata ?? null,
        mediaUri: meta?.mediaUri ?? null,
        createdAt: BigInt(event.block.timestamp),
      })
      .onConflictDoNothing()
  } else {
    // Transfer or sale — update owner (guard: token may predate our window)
    const token = await db.find(schema.tokens, { id: tokenPk })
    if (token) {
      await db
        .update(schema.tokens, { id: tokenPk })
        .set({ owner: to })
    }
  }
})
