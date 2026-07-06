import { ponder } from "ponder:registry"
import { collections, collectionMints, collectionTokens } from "ponder:schema"

/**
 * PND Collection System (contracts/src/collection/) handlers.
 *
 * DEPLOY-GATED: SovereignCollectionFactory + SovereignCollection are only
 * present in ponder.config.ts's `contracts` once the real factory address
 * replaces the zero-address sentinel there. Until then, Ponder's generated
 * `EventNames` type structurally does not include
 * "SovereignCollectionFactory:CollectionCreated" /
 * "SovereignCollection:Minted" / "SovereignCollection:Burned" — there is
 * nothing in `contracts` for those strings to refer to.
 *
 * `ponder.on` is deliberately typed generically over the live config (see
 * node_modules/ponder Virtual.Registry), so a handler for a not-yet-
 * configured contract can't type-check as a literal call. Rather than
 * fight that by inventing a fake config-shaped type (or, worse, writing
 * real indexing logic against phantom types), this file registers through
 * `ponder.on` cast to its own generic shape at this one boundary — the
 * single place a deploy-gated contract's handlers meet Ponder's config-
 * derived typing. Every other line here (args, db calls, schema tables) is
 * fully typed against the real ponder.schema.ts tables.
 *
 * At runtime this is inert either way: when the factory isn't in
 * `contracts`, Ponder never emits these events, so these callbacks simply
 * never fire (same as any other unregistered event name — not an error).
 * Once the factory address is set in ponder.config.ts and `ponder codegen`
 * is re-run, these become ordinary statically-typed handlers with no
 * further change needed here.
 *
 * Kept minimal per AGENTS.md: handlers just mirror onchain state into
 * `collections` / `collection_tokens` / `collection_mints`. Metadata
 * enrichment, rendering, and anything beyond raw event data is out of
 * scope here — that's the worker's/web's job reading these rows.
 */

type GatedIndexingFunction = (args: {
  event: any
  context: any
}) => Promise<void> | void

const on = ponder.on as unknown as (
  name: string,
  fn: GatedIndexingFunction,
) => void

const tokenRowId = (collection: string, tokenId: bigint) =>
  `${collection.toLowerCase()}-${tokenId.toString()}`

// ─── Factory discovery ────────────────────────────────────────────────────

on("SovereignCollectionFactory:CollectionCreated", async ({ event, context }) => {
  const { owner, collection } = event.args
  await context.db
    .insert(collections)
    .values({
      collection,
      owner,
      createdAtBlock: event.block.number,
      createdAtTime: event.block.timestamp,
      createdTxHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

// ─── Per-collection state machine (via factory() child indexing) ────────

// One event per mint call. Built-in paid paths cover the contiguous range
// [firstTokenId, firstTokenId + quantity - 1]; extension mints (mintTo,
// mintToAt) always emit quantity 1. A pooled collection may re-mint a
// previously burned tokenId (mintToAt) — same id, new instance: the row
// is UPDATEd in place with fresh mark fields and burned reset to false,
// not inserted as a second row (there is exactly one live row per
// (collection, tokenId) at any time; collection_mints is the immutable
// history of every mint call, including re-mints).
on("SovereignCollection:Minted", async ({ event, context }) => {
  const { to, surface, firstTokenId, quantity, firstMintIndex, mintBlock, statusAtMint } =
    event.args as {
      to: `0x${string}`
      surface: `0x${string}`
      firstTokenId: bigint
      quantity: bigint
      firstMintIndex: bigint
      mintBlock: bigint
      statusAtMint: number
    }
  const collection = event.log.address as `0x${string}`

  await context.db
    .insert(collectionMints)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      collection,
      firstTokenId,
      quantity,
      to,
      surface,
      mintBlock,
      statusAtMint,
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
        surface,
        mintBlock,
        mintIndex,
        statusAtMint,
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
        surface,
        mintBlock,
        mintIndex,
        statusAtMint,
        burned: false,
        updatedAtBlock: event.block.number,
        updatedAtTime: event.block.timestamp,
      })
    }
  }
})

on("SovereignCollection:Burned", async ({ event, context }) => {
  const { tokenId } = event.args as { tokenId: bigint }
  const collection = event.log.address as `0x${string}`
  const id = tokenRowId(collection, tokenId)
  const existing = await context.db.find(collectionTokens, { id })
  if (!existing) return
  await context.db.update(collectionTokens, { id }).set({
    burned: true,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})
