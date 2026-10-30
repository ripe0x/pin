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
import { surfaceTokenV2Abi } from "../abis/SurfaceTokenV2"
import { fixedPriceSaleAbi } from "../abis/FixedPriceSale"

/**
 * PND Surface System handlers: v1 (contracts/src/surface/) and the v2
 * primitives (contracts/src/surface/v2/, docs/pnd-surface-v2-design.md).
 *
 * Kept minimal per AGENTS.md: handlers mirror onchain state into
 * `collections` / `collection_tokens` / `collection_mints` /
 * `collection_sales` / `collection_referrals` / `minters`. Metadata
 * enrichment, rendering, and anything beyond event data plus one
 * creation-time read per v2 clone is the worker's/web's job.
 *
 * v1 (SurfaceFactory/Surface/FixedPriceMinter) and v2
 * (SurfaceTokenFactoryV2/SurfaceSaleFactoryV2/LauncherV2/SurfaceV2/
 * FixedPriceSaleV2) share the handler functions whose events are
 * byte-identical (Burned, Sold, ReferralPaid); everything else is
 * per-version.
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

ponder.on("SurfaceFactory:SurfaceCreated", async ({ event, context }) => {
  const { owner, collection, primaryMinter, idMode, name, symbol } = event.args
  const hasPrimaryMinter = primaryMinter.toLowerCase() !== ZERO_ADDRESS
  await context.db
    .insert(collections)
    .values({
      collection,
      owner,
      protocolVersion: 1,
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
})

// Keeps collections.primaryMinter current after deploy: a sequential
// collection's owner/admin can repoint it (setPrimaryMinter), and either
// form clears it to zero when the current primary is revoked. Pooled
// collections emit this automatically as their sole minter changes. Does
// NOT touch the `minters` reverse index: that stays keyed to the
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

// Keeps the owner current and marks owner() reaching address(0) (v1's OZ
// Ownable2Step base allows a direct renounceOwnership call).
ponder.on("Surface:OwnershipTransferred", async ({ event, context }) => {
  const { newOwner } = event.args
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  const ownerRenounced = newOwner.toLowerCase() === ZERO_ADDRESS
  await context.db.update(collections, { collection }).set({ owner: newOwner, ownerRenounced })
})

// ─── Per-collection state machine (via factory() child indexing) ────────

// One event per mint call. mintTo covers the contiguous range
// [firstTokenId, firstTokenId + quantity - 1]; mintToId always emits
// quantity 1. A pooled collection may re-mint a previously burned tokenId
// (mintToId): same id, new instance: the row is UPDATEd in place with
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
// Sold/ReferralPaid are emitted by the minter/sale clone itself
// (event.log.address is the minter, not the collection), so both handlers
// resolve the owning collection via the `minters` reverse index (v1:
// SurfaceCreated above; v2: SurfaceSaleFactoryV2:Created below). A miss
// means the clone has no indexed collection: for v2, a sale bound to a
// collection the token factory did not make. Skipped, not thrown.

const soldHandler: HandlerFor<"FixedPriceSaleV2:Sold"> = async ({ event, context }) => {
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
ponder.on("FixedPriceSaleV2:Sold", soldHandler)

const referralPaidHandler: HandlerFor<"FixedPriceSaleV2:ReferralPaid"> = async ({ event, context }) => {
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
ponder.on("FixedPriceSaleV2:ReferralPaid", referralPaidHandler)

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

// ─── Surface v2 primitives ──────────────────────────────────────────────
//
// Ordering: a clone's initializer runs inside the factory's create call,
// so the clone's own init logs (OwnershipTransferred from zero, RendererSet,
// RoyaltySet, SupplyCapSet, MinterSet for a token; PriceSet etc. for a
// sale) precede the factory's Created log in the same transaction. Ponder
// matches factory children by block, so those init logs DO reach the
// SurfaceV2 handlers below, before the Created handler has inserted the
// row. Every per-collection handler therefore skips when the row is
// missing, which is exactly what keeps init events from counting as an
// owner action, and the Created handler reads the post-init state itself.

// The token CloneFactory only ever clones the v2 Surface implementation, so
// a Created log here is the collection's proof of origin. Created carries
// no owner or name, so one multicall (a single eth_call) per collection
// reads them at the creation block.
ponder.on("SurfaceTokenFactoryV2:Created", async ({ event, context }) => {
  const collection = event.args.instance
  const [owner, name, symbol, minter] = await context.client.multicall({
    allowFailure: false,
    contracts: [
      { address: collection, abi: surfaceTokenV2Abi, functionName: "owner" },
      { address: collection, abi: surfaceTokenV2Abi, functionName: "name" },
      { address: collection, abi: surfaceTokenV2Abi, functionName: "symbol" },
      { address: collection, abi: surfaceTokenV2Abi, functionName: "minter" },
    ],
  })
  await context.db
    .insert(collections)
    .values({
      collection,
      owner,
      protocolVersion: 2,
      ownerRenounced: owner.toLowerCase() === ZERO_ADDRESS,
      // Anyone can create or launch naming any owner; only the owner sending
      // the transaction itself counts as consent here.
      ownerConfirmed: event.transaction.from.toLowerCase() === owner.toLowerCase(),
      name,
      symbol,
      primaryMinter: minter.toLowerCase() === ZERO_ADDRESS ? null : minter,
      idMode: 0,
      createdAtBlock: event.block.number,
      createdAtTime: event.block.timestamp,
      createdTxHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

// A sale-factory clone is a genuine FixedPriceSale (version() == 2 by
// construction), but its collection() is whatever its initializer was
// given, which may be a contract the token factory never made. Only sales
// whose collection has a v2 `collections` row are indexed. Whether the
// sale is the collection's current minter is `collections.primaryMinter`;
// a Sold log itself proves it was at that moment, since Surface.mintTo
// accepts only minter().
ponder.on("SurfaceSaleFactoryV2:Created", async ({ event, context }) => {
  const sale = event.args.instance
  const collection = await context.client.readContract({
    address: sale,
    abi: fixedPriceSaleAbi,
    functionName: "collection",
  })
  const row = await context.db.find(collections, { collection })
  if (!row || row.protocolVersion !== 2) return
  await context.db.insert(minters).values({ minter: sale, collection }).onConflictDoNothing()
})

// Launch-path record only. `owner` is whatever the caller passed, so it is
// not that address's consent and is not used here.
ponder.on("LauncherV2:Launched", async ({ event, context }) => {
  const { collection } = event.args
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  await context.db.update(collections, { collection }).set({ launcher: event.log.address })
})

// Any owner-only setter after creation is the current owner acting (init
// emissions are skipped, see the ordering note above).
// Typed structurally (only log.address and db are used) so one function
// serves three events with different args.
const ownerActedHandler = async ({ event, context }: {
  event: { log: { address: `0x${string}` } }
  context: { db: Virtual.Context<PonderConfig, PonderSchema, "SurfaceV2:RendererSet">["db"] }
}) => {
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  await context.db.update(collections, { collection }).set({ ownerConfirmed: true })
}

ponder.on("SurfaceV2:RendererSet", ownerActedHandler)
ponder.on("SurfaceV2:SupplyCapSet", ownerActedHandler)
ponder.on("SurfaceV2:RoyaltySet", ownerActedHandler)

ponder.on("SurfaceV2:MinterSet", async ({ event, context }) => {
  const { minter } = event.args
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  await context.db.update(collections, { collection }).set({
    primaryMinter: minter.toLowerCase() === ZERO_ADDRESS ? null : minter,
    ownerConfirmed: true,
  })
})

ponder.on("SurfaceV2:NameSet", async ({ event, context }) => {
  const { name, symbol } = event.args
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  await context.db.update(collections, { collection }).set({ name, symbol, ownerConfirmed: true })
})

// OZ Ownable pushes ownership without the new owner's acceptance, so the
// new owner is unconfirmed until it acts (or sent this transaction).
ponder.on("SurfaceV2:OwnershipTransferred", async ({ event, context }) => {
  const { newOwner } = event.args
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return
  await context.db.update(collections, { collection }).set({
    owner: newOwner,
    ownerRenounced: newOwner.toLowerCase() === ZERO_ADDRESS,
    ownerConfirmed: event.transaction.from.toLowerCase() === newOwner.toLowerCase(),
  })
})

// Ids equal mint order and are never reused, so every token id gets one
// insert. mintIndex is the offset within this Minted call, per the column.
ponder.on("SurfaceV2:Minted", async ({ event, context }) => {
  const { minter, to, firstTokenId, quantity } = event.args
  const collection = event.log.address
  const existing = await context.db.find(collections, { collection })
  if (!existing) return

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

  const rows = []
  for (let i = 0n; i < quantity; i++) {
    const tokenId = firstTokenId + i
    rows.push({
      id: tokenRowId(collection, tokenId),
      collection,
      tokenId,
      mintedTo: to,
      minter,
      mintIndex: Number(i),
      burned: false,
      updatedAtBlock: event.block.number,
      updatedAtTime: event.block.timestamp,
    })
  }
  await context.db.insert(collectionTokens).values(rows).onConflictDoNothing()
})
