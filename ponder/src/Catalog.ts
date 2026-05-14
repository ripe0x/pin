import { ponder } from "ponder:registry"
import {
  catalogContracts,
  catalogTokens,
  catalogRanges,
} from "ponder:schema"

/**
 * Event handlers for the Catalog contract. Six events
 * — Added/Removed pairs for contracts, tokens, and token ranges —
 * mirrored into three tables keyed by `(artist, …)` so the web app's
 * `/catalog/[address]` page can read from Postgres instead of running
 * a viem multicall on every cache miss.
 *
 * The on-chain contract enforces uniqueness on writes (Catalog.sol's
 * `ContractAlreadyRegistered` / `TokenAlreadyRegistered` /
 * `TokenRangeAlreadyRegistered` guards), so a re-org that re-emits an
 * Added event lands the same row. `onConflictDoNothing` keeps that
 * idempotent.
 *
 * Removed handlers delete the row by its synthetic id. A re-org that
 * re-emits a Removed event with no surviving row is a no-op — the
 * delete just affects zero rows.
 *
 * `actor` (msg.sender at the time of the call) is preserved as audit
 * trail: it's the artist for direct calls and the operator address for
 * `*For` calls. Page reads filter strictly on `artist`.
 */

const contractId = (artist: string, contractAddress: string) =>
  `${artist.toLowerCase()}-${contractAddress.toLowerCase()}`

const tokenId = (artist: string, contractAddress: string, tid: bigint) =>
  `${artist.toLowerCase()}-${contractAddress.toLowerCase()}-${tid.toString()}`

const rangeId = (
  artist: string,
  contractAddress: string,
  start: bigint,
  end: bigint,
) =>
  `${artist.toLowerCase()}-${contractAddress.toLowerCase()}-${start.toString()}-${end.toString()}`

// ─── Contracts ───────────────────────────────────────────────────────────

ponder.on("Catalog:ContractAdded", async ({ event, context }) => {
  const { artist, actor, contractAddress } = event.args
  await context.db
    .insert(catalogContracts)
    .values({
      id: contractId(artist, contractAddress),
      artist,
      contractAddress,
      actor,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("Catalog:ContractRemoved", async ({ event, context }) => {
  const { artist, contractAddress } = event.args
  await context.db.delete(catalogContracts, {
    id: contractId(artist, contractAddress),
  })
})

// ─── Tokens ──────────────────────────────────────────────────────────────

ponder.on("Catalog:TokenAdded", async ({ event, context }) => {
  const { artist, actor, contractAddress, tokenId: tid } = event.args
  await context.db
    .insert(catalogTokens)
    .values({
      id: tokenId(artist, contractAddress, tid),
      artist,
      contractAddress,
      tokenId: tid,
      actor,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("Catalog:TokenRemoved", async ({ event, context }) => {
  const { artist, contractAddress, tokenId: tid } = event.args
  await context.db.delete(catalogTokens, {
    id: tokenId(artist, contractAddress, tid),
  })
})

// ─── Token ranges ────────────────────────────────────────────────────────

ponder.on("Catalog:TokenRangeAdded", async ({ event, context }) => {
  const { artist, actor, contractAddress, startTokenId, endTokenId } =
    event.args
  await context.db
    .insert(catalogRanges)
    .values({
      id: rangeId(artist, contractAddress, startTokenId, endTokenId),
      artist,
      contractAddress,
      startTokenId,
      endTokenId,
      actor,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("Catalog:TokenRangeRemoved", async ({ event, context }) => {
  const { artist, contractAddress, startTokenId, endTokenId } = event.args
  await context.db.delete(catalogRanges, {
    id: rangeId(artist, contractAddress, startTokenId, endTokenId),
  })
})
