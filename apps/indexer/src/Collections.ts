import { ponder } from "ponder:registry"
import type { Virtual } from "ponder"
import {
  collections,
  collectionMints,
  collectionTokens,
  collectionReferrals,
  collectionSales,
  minters,
} from "ponder:schema"

/**
 * PND Surface System (contracts/src/surface/, contracts/src/surface/v2/)
 * handlers, v1 and v2 sharing one set of functions.
 *
 * Kept minimal per AGENTS.md: handlers just mirror onchain state into
 * `collections` / `collection_tokens` / `collection_mints` /
 * `collection_sales` / `collection_referrals` / `minters`. Metadata
 * enrichment, rendering, and anything beyond raw event data is out of
 * scope here: that's the worker's/web's job reading these rows.
 *
 * v1 (SurfaceFactory/Surface/FixedPriceMinter) and v2
 * (SurfaceFactoryV2/SurfaceV2/FixedPriceMinterV2, see
 * docs/pnd-surface-v2-plan.md) emit byte-identical event shapes for
 * every function below, so one function registers under both contract
 * names: only `makeSurfaceCreatedHandler`'s `protocolVersion` argument
 * differs. Both are unconditionally present in ponder.config.ts's
 * `contracts` (v2 falls back to the zero address on a network with no
 * deployment yet), so every registration below is a plain, always-on
 * `ponder.on(...)` call.
 *
 * `HandlerFor<Name>` pins each shared function's parameter type to one
 * canonical event name's real inferred type (ponder.on's own generic),
 * rather than writing the shape out by hand or typing it `any`. Passing
 * that same function to the sibling event name below then typechecks
 * because the two events are byte-identical, so the sibling's inferred
 * handler type is structurally the same.
 */

type PonderConfig = typeof import("../ponder.config").default
type PonderSchema = typeof import("../ponder.schema")
type EventName = Virtual.EventNames<PonderConfig>
type HandlerFor<Name extends EventName> = (args: {
  event: Virtual.Event<PonderConfig, Name>
  context: Virtual.Context<PonderConfig, PonderSchema, Name>
}) => Promise<void> | void

const tokenRowId = (collection: string, tokenId: bigint) =>
  `${collection.toLowerCase()}-${tokenId.toString()}`

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

// ─── Factory discovery ────────────────────────────────────────────────────

function makeSurfaceCreatedHandler(protocolVersion: 1 | 2): HandlerFor<"SurfaceFactoryV2:SurfaceCreated"> {
  return async ({ event, context }) => {
    const { owner, collection, primaryMinter, idMode, name, symbol } = event.args
    const hasPrimaryMinter = primaryMinter.toLowerCase() !== ZERO_ADDRESS
    await context.db
      .insert(collections)
      .values({
        collection,
        owner,
        protocolVersion,
        royaltyLocked: false,
        ownerRenounced: false,
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
    // binding): a later primaryMinter repoint doesn't add/remove rows here.
    // createSurfaceCustom/createPooledSurface with no primary supplied emit
    // primaryMinter = address(0), so there's nothing to index here.
    if (hasPrimaryMinter) {
      await context.db
        .insert(minters)
        .values({ minter: primaryMinter, collection })
        .onConflictDoNothing()
    }
  }
}

ponder.on("SurfaceFactory:SurfaceCreated", makeSurfaceCreatedHandler(1))
ponder.on("SurfaceFactoryV2:SurfaceCreated", makeSurfaceCreatedHandler(2))

// Keeps collections.primaryMinter current after deploy: a sequential
// collection's owner/admin can repoint it (setPrimaryMinter), and either
// form clears it to zero when the current primary is revoked. Pooled
// collections emit this automatically as their sole minter changes. Does
// NOT touch the `minters` reverse index: that stays keyed to the
// SurfaceCreated-time canonical clone regardless of later repoints.
const primaryMinterSetHandler: HandlerFor<"SurfaceV2:PrimaryMinterSet"> = async ({ event, context }) => {
  const { minter } = event.args
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  const hasPrimaryMinter = minter.toLowerCase() !== ZERO_ADDRESS
  await context.db
    .update(collections, { collection })
    .set({ primaryMinter: hasPrimaryMinter ? minter : null })
}

ponder.on("Surface:PrimaryMinterSet", primaryMinterSetHandler)
ponder.on("SurfaceV2:PrimaryMinterSet", primaryMinterSetHandler)

// v2 only: royalty gets a one-way lock (setRoyalty reverts once engaged).
// v1 has no lockRoyalty, so collections.royaltyLocked stays false there.
// Registered only for SurfaceV2 (v1 has no matching event), so this one
// is typed directly against its own event, no shared HandlerFor needed.
ponder.on("SurfaceV2:RoyaltyLocked", async ({ event, context }) => {
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  await context.db.update(collections, { collection }).set({ royaltyLocked: true })
})

// owner() reaching address(0). v2's seal() reaches it, and v1's OZ
// Ownable2Step base still allows a direct renounceOwnership call, so
// this registers for both versions.
const ownershipTransferredHandler: HandlerFor<"SurfaceV2:OwnershipTransferred"> = async ({ event, context }) => {
  const { newOwner } = event.args
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  const ownerRenounced = newOwner.toLowerCase() === ZERO_ADDRESS
  await context.db.update(collections, { collection }).set({ ownerRenounced })
}

ponder.on("Surface:OwnershipTransferred", ownershipTransferredHandler)
ponder.on("SurfaceV2:OwnershipTransferred", ownershipTransferredHandler)

// ─── Per-collection state machine (via factory() child indexing) ────────

// One event per mint call. mintTo covers the contiguous range
// [firstTokenId, firstTokenId + quantity - 1]; mintToId always emits
// quantity 1. A pooled collection may re-mint a previously burned tokenId
// (mintToId): same id, new instance: the row is UPDATEd in place with
// fresh mark fields and burned reset to false, not inserted as a second
// row (there is exactly one live row per (collection, tokenId) at any
// time; collection_mints is the immutable history of every mint call,
// including re-mints).
const mintedHandler: HandlerFor<"SurfaceV2:Minted"> = async ({ event, context }) => {
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
}

ponder.on("Surface:Minted", mintedHandler)
ponder.on("SurfaceV2:Minted", mintedHandler)

// ─── Canonical minter sale record (via factory() child indexing) ────────
//
// Sold/ReferralPaid are emitted by the FixedPriceMinter clone itself
// (event.log.address is the minter, not the collection), so both handlers
// resolve the owning collection via the `minters` reverse index populated
// in SurfaceCreated above. A minter row always exists for any minter Ponder
// is subscribed to (they're the same factory() child set), so a miss here
// means an event arrived before its own SurfaceCreated indexed: not
// expected, but handled by skipping the row rather than throwing.

const soldHandler: HandlerFor<"FixedPriceMinterV2:Sold"> = async ({ event, context }) => {
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
}

ponder.on("FixedPriceMinter:Sold", soldHandler)
ponder.on("FixedPriceMinterV2:Sold", soldHandler)

const referralPaidHandler: HandlerFor<"FixedPriceMinterV2:ReferralPaid"> = async ({ event, context }) => {
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
}

ponder.on("FixedPriceMinter:ReferralPaid", referralPaidHandler)
ponder.on("FixedPriceMinterV2:ReferralPaid", referralPaidHandler)

const burnedHandler: HandlerFor<"SurfaceV2:Burned"> = async ({ event, context }) => {
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
}

ponder.on("Surface:Burned", burnedHandler)
ponder.on("SurfaceV2:Burned", burnedHandler)
