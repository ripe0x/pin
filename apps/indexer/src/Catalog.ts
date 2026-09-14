import { onIf, MAINNET_MODE } from "./chainMode"
import {
  catalogContracts,
  catalogTokens,
  catalogRanges,
} from "ponder:schema"

/**
 * Catalog handlers (verbatim from v1; the on-chain contract surface
 * hasn't changed). Six events — Added/Removed pairs for contracts,
 * tokens, and token ranges — mirror into three tables keyed by
 * (artist, …).
 */

const contractId = (artist: string, contractAddress: string) =>
  `${artist.toLowerCase()}-${contractAddress.toLowerCase()}`

const tokenId = (artist: string, contractAddress: string, tid: bigint) =>
  `${artist.toLowerCase()}-${contractAddress.toLowerCase()}-${tid.toString()}`

const rangeId = (artist: string, contractAddress: string, start: bigint, end: bigint) =>
  `${artist.toLowerCase()}-${contractAddress.toLowerCase()}-${start.toString()}-${end.toString()}`

onIf(MAINNET_MODE, "Catalog:ContractAdded", async ({ event, context }) => {
  const { artist, actor, contractAddress } = event.args
  await context.db
    .insert(catalogContracts)
    .values({
      id: contractId(artist, contractAddress),
      artist, contractAddress, actor,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

onIf(MAINNET_MODE, "Catalog:ContractRemoved", async ({ event, context }) => {
  const { artist, contractAddress } = event.args
  await context.db.delete(catalogContracts, {
    id: contractId(artist, contractAddress),
  })
})

onIf(MAINNET_MODE, "Catalog:TokenAdded", async ({ event, context }) => {
  const { artist, actor, contractAddress, tokenId: tid } = event.args
  await context.db
    .insert(catalogTokens)
    .values({
      id: tokenId(artist, contractAddress, tid),
      artist, contractAddress, tokenId: tid, actor,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

onIf(MAINNET_MODE, "Catalog:TokenRemoved", async ({ event, context }) => {
  const { artist, contractAddress, tokenId: tid } = event.args
  await context.db.delete(catalogTokens, {
    id: tokenId(artist, contractAddress, tid),
  })
})

onIf(MAINNET_MODE, "Catalog:TokenRangeAdded", async ({ event, context }) => {
  const { artist, actor, contractAddress, startTokenId, endTokenId } =
    event.args
  await context.db
    .insert(catalogRanges)
    .values({
      id: rangeId(artist, contractAddress, startTokenId, endTokenId),
      artist, contractAddress, startTokenId, endTokenId, actor,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

onIf(MAINNET_MODE, "Catalog:TokenRangeRemoved", async ({ event, context }) => {
  const { artist, contractAddress, startTokenId, endTokenId } = event.args
  await context.db.delete(catalogRanges, {
    id: rangeId(artist, contractAddress, startTokenId, endTokenId),
  })
})
