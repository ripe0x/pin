import { ponder } from "ponder:registry"
import {
  collections,
  collectionMints,
  collectionTokens,
  collectionReferrals,
  collectionSales,
  collectionSupplyConfigs,
  minters,
  minterSaleConfigs,
  tokenOwnership,
} from "ponder:schema"

/**
 * PND Surface System (contracts/src/surface/) handlers.
 *
 * Kept minimal per AGENTS.md: handlers just mirror onchain state into
 * `collections` / `collection_tokens` / `collection_mints` /
 * `collection_sales` / `collection_referrals` / `minters`. Metadata
 * enrichment, rendering, and anything beyond raw event data is out of
 * scope here — that's the worker's/web's job reading these rows.
 */

const tokenRowId = (collection: string, tokenId: bigint) =>
  `${collection.toLowerCase()}-${tokenId.toString()}`

// ─── Factory discovery ────────────────────────────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

ponder.on("SurfaceFactory:SurfaceCreated", async ({ event, context }) => {
  const { owner, collection, primaryMinter, idMode, name, symbol } = event.args
  const hasPrimaryMinter = primaryMinter.toLowerCase() !== ZERO_ADDRESS
  await context.db
    .insert(collections)
    .values({
      collection,
      owner,
      name,
      symbol,
      primaryMinter: hasPrimaryMinter ? primaryMinter : null,
      idMode: Number(idMode),
      createdAtBlock: event.block.number,
      createdAtTime: event.block.timestamp,
      createdTxHash: event.transaction.hash,
    })
    .onConflictDoNothing()

  // Reverse index for FixedPriceMinter:Sold/ReferralPaid, which are emitted
  // by the minter clone and carry no collection field of their own. Fixed
  // at creation time (see ponder.config.ts's FixedPriceMinter factory()
  // binding) — a later primaryMinter repoint doesn't add/remove rows here.
  // createSurfaceCustom/createPooledSurface with no primary supplied emit
  // primaryMinter = address(0), so there's nothing to index here.
  if (hasPrimaryMinter) {
    await context.db
      .insert(minters)
      .values({ minter: primaryMinter, collection })
      .onConflictDoNothing()
  }
})

// Keeps collections.primaryMinter current after deploy: a sequential
// collection's owner/admin can repoint it (setPrimaryMinter), and either
// form clears it to zero when the current primary is revoked. Pooled
// collections emit this automatically as their sole minter changes. Does
// NOT touch the `minters` reverse index — that stays keyed to the
// SurfaceCreated-time canonical clone regardless of later repoints.
ponder.on("Surface:PrimaryMinterSet", async ({ event, context }) => {
  const { minter } = event.args
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  const hasPrimaryMinter = minter.toLowerCase() !== ZERO_ADDRESS
  await context.db
    .update(collections, { collection })
    .set({ primaryMinter: hasPrimaryMinter ? minter : null })
})

ponder.on("Surface:SurfaceConfigured", async ({ event, context }) => {
  const collection = event.log.address
  await context.db
    .insert(collectionSupplyConfigs)
    .values({
      collection,
      supplyCap: event.args.supplyCap,
      updatedAtBlock: event.block.number,
      updatedAtTime: event.block.timestamp,
    })
    .onConflictDoUpdate({
      supplyCap: event.args.supplyCap,
      updatedAtBlock: event.block.number,
      updatedAtTime: event.block.timestamp,
    })
})

ponder.on("Surface:SupplyCapSet", async ({ event, context }) => {
  const collection = event.log.address
  await context.db
    .insert(collectionSupplyConfigs)
    .values({
      collection,
      supplyCap: event.args.supplyCap,
      updatedAtBlock: event.block.number,
      updatedAtTime: event.block.timestamp,
    })
    .onConflictDoUpdate({
      supplyCap: event.args.supplyCap,
      updatedAtBlock: event.block.number,
      updatedAtTime: event.block.timestamp,
    })
})

// ─── Canonical FixedPriceMinter release state ────────────────────────────

ponder.on("FixedPriceMinter:MinterConfigured", async ({ event, context }) => {
  const minter = event.log.address
  const { collection, price, priceStrategy, mintStart, mintEnd, maxMints } =
    event.args
  await context.db
    .insert(minterSaleConfigs)
    .values({
      minter,
      collection,
      price,
      priceStrategy,
      mintStart,
      mintEnd,
      maxMints,
      updatedAtBlock: event.block.number,
      updatedAtTime: event.block.timestamp,
    })
    .onConflictDoUpdate({
      collection,
      price,
      priceStrategy,
      mintStart,
      mintEnd,
      maxMints,
      updatedAtBlock: event.block.number,
      updatedAtTime: event.block.timestamp,
    })
})

ponder.on("FixedPriceMinter:PriceSet", async ({ event, context }) => {
  const minter = event.log.address
  const existing = await context.db.find(minterSaleConfigs, { minter })
  if (!existing) return
  await context.db.update(minterSaleConfigs, { minter }).set({
    price: event.args.price,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})

ponder.on("FixedPriceMinter:PriceStrategySet", async ({ event, context }) => {
  const minter = event.log.address
  const existing = await context.db.find(minterSaleConfigs, { minter })
  if (!existing) return
  await context.db.update(minterSaleConfigs, { minter }).set({
    priceStrategy: event.args.strategy,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})

ponder.on("FixedPriceMinter:MintWindowSet", async ({ event, context }) => {
  const minter = event.log.address
  const existing = await context.db.find(minterSaleConfigs, { minter })
  if (!existing) return
  await context.db.update(minterSaleConfigs, { minter }).set({
    mintStart: event.args.mintStart,
    mintEnd: event.args.mintEnd,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})

ponder.on("FixedPriceMinter:MaxMintsSet", async ({ event, context }) => {
  const minter = event.log.address
  const existing = await context.db.find(minterSaleConfigs, { minter })
  if (!existing) return
  await context.db.update(minterSaleConfigs, { minter }).set({
    maxMints: event.args.maxMints,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})

// ─── Per-collection state machine (via factory() child indexing) ────────

// One event per mint call. mintTo covers the contiguous range
// [firstTokenId, firstTokenId + quantity - 1]; mintToId always emits
// quantity 1. A pooled collection may re-mint a previously burned tokenId
// (mintToId) — same id, new instance: the row is UPDATEd in place with
// fresh mark fields and burned reset to false, not inserted as a second
// row (there is exactly one live row per (collection, tokenId) at any
// time; collection_mints is the immutable history of every mint call,
// including re-mints).
ponder.on("Surface:Minted", async ({ event, context }) => {
  const { minter, to, firstTokenId, quantity, firstMintIndex } = event.args
  const collection = event.log.address

  await context.db
    .insert(collectionMints)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      collection,
      minter,
      firstTokenId,
      quantity,
      to,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()

  for (let i = 0n; i < quantity; i++) {
    const tokenId = firstTokenId + i
    const id = tokenRowId(collection, tokenId)
    const existing = await context.db.find(collectionTokens, { id })
    const mintIndex = Number(firstMintIndex + i)

    if (existing) {
      // Pooled re-mint of a previously burned id: fresh mark, live again.
      await context.db.update(collectionTokens, { id }).set({
        mintedTo: to,
        minter,
        mintIndex,
        burned: false,
        updatedAtBlock: event.block.number,
        updatedAtTime: event.block.timestamp,
      })
    } else {
      await context.db.insert(collectionTokens).values({
        id,
        collection,
        tokenId,
        mintedTo: to,
        minter,
        mintIndex,
        burned: false,
        updatedAtBlock: event.block.number,
        updatedAtTime: event.block.timestamp,
      })
    }
  }
})

// ─── Canonical minter sale record (via factory() child indexing) ────────
//
// Sold/ReferralPaid are emitted by the FixedPriceMinter clone itself
// (event.log.address is the minter, not the collection), so both handlers
// resolve the owning collection via the `minters` reverse index populated
// in SurfaceCreated above. A minter row always exists for any minter Ponder
// is subscribed to (they're the same factory() child set), so a miss here
// means an event arrived before its own SurfaceCreated indexed — not
// expected, but handled by skipping the row rather than throwing.

ponder.on("FixedPriceMinter:Sold", async ({ event, context }) => {
  const minter = event.log.address
  const row = await context.db.find(minters, { minter })
  if (!row) return
  const { payer, to, referrer, quantity, paid, firstTokenId } = event.args
  await context.db
    .insert(collectionSales)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      collection: row.collection,
      minter,
      payer,
      to,
      referrer,
      quantity,
      paid,
      firstTokenId,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("FixedPriceMinter:ReferralPaid", async ({ event, context }) => {
  const minter = event.log.address
  const row = await context.db.find(minters, { minter })
  if (!row) return
  const { referrer, amount } = event.args
  await context.db
    .insert(collectionReferrals)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      collection: row.collection,
      minter,
      referrer,
      amount,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("Surface:Burned", async ({ event, context }) => {
  const { tokenId } = event.args
  const collection = event.log.address
  const id = tokenRowId(collection, tokenId)
  const existing = await context.db.find(collectionTokens, { id })
  if (!existing) return
  await context.db.update(collectionTokens, { id }).set({
    burned: true,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})

// Current ownership is derived from the ERC-721 Transfer stream already
// emitted by every factory-created Surface. `Minted.to` remains mint
// provenance; it must not be repurposed as a live owner field.
ponder.on("Surface:Transfer", async ({ event, context }) => {
  const { to, tokenId } = event.args
  const contract = event.log.address
  const current = {
    owner: to,
    source: "ponder-surface",
    coverageStatus: "complete",
    lastBlock: event.block.number,
    logIndex: event.log.logIndex,
    blockTime: event.block.timestamp,
    txHash: event.transaction.hash,
  }
  await context.db
    .insert(tokenOwnership)
    .values({
      id: tokenRowId(contract, tokenId),
      contract,
      tokenId,
      ...current,
    })
    .onConflictDoUpdate(current)
})
