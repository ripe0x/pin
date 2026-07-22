import { ponder } from "ponder:registry"
import {
  collections,
  collectionMints,
  collectionTokens,
  collectionReferrals,
  collectionSales,
  minters,
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
