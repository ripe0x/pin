import { ponder } from "ponder:registry"
import { muriContracts, muriTokens } from "ponder:schema"
import { muriProtocolAbi } from "../abis/MURIProtocol"

/**
 * MURI Protocol singleton handlers (preservation overlay).
 *
 * `muri_contracts` ← ContractRegistered (one row per NFT contract that
 * enabled MURI). `muri_tokens` ← per-token preservation state for the web
 * "preserved on-chain · N fallbacks" badge.
 *
 * The TokenDataInitialized event carries no URI count, so on each data-
 * changing event we read getArtwork() once to keep counts authoritative.
 * These reads are bounded to MURI events (low volume). We deliberately do
 * NOT catch read errors — a transient RPC failure should let Ponder retry
 * the event rather than persist a wrong count.
 */

const MURI_ADDRESS = "0x0000000000C2A0B63ab4aA971B08B905E5875b01" as const

const idOf = (contract: string, tokenId: bigint) =>
  `${contract.toLowerCase()}-${tokenId.toString()}`

type Ctx = Parameters<Parameters<typeof ponder.on>[1]>[0]["context"]

async function refreshToken(
  context: Ctx,
  contract: `0x${string}`,
  tokenId: bigint,
  blockNumber: bigint,
  blockTime: bigint,
) {
  const artwork = await context.client.readContract({
    abi: muriProtocolAbi,
    address: MURI_ADDRESS,
    functionName: "getArtwork",
    args: [contract, tokenId],
  })

  const base = {
    artistUriCount: artwork.artistUris.length,
    collectorUriCount: artwork.collectorUris.length,
    selectedIndex: Number(artwork.selectedArtistUriIndex),
    mimeType: artwork.mimeType || null,
    fileHash: artwork.fileHash || null,
    isAnimationUri: artwork.isAnimationUri,
    updatedAtBlock: blockNumber,
  }

  await context.db
    .insert(muriTokens)
    .values({
      id: idOf(contract, tokenId),
      contract,
      tokenId,
      ...base,
      displayMode: null,
      registeredAtBlock: blockNumber,
      registeredAtTime: blockTime,
    })
    .onConflictDoUpdate(base)
}

ponder.on("MURIProtocol:ContractRegistered", async ({ event, context }) => {
  const { contractAddress, implementationAddress, registerer } = event.args
  await context.db
    .insert(muriContracts)
    .values({
      contract: contractAddress,
      operator: implementationAddress,
      registerer,
      registeredAtBlock: event.block.number,
      registeredAtTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("MURIProtocol:TokenDataInitialized", async ({ event, context }) => {
  await refreshToken(
    context,
    event.args.creator,
    event.args.tokenId,
    event.block.number,
    event.block.timestamp,
  )
})

ponder.on("MURIProtocol:ArtworkUrisAdded", async ({ event, context }) => {
  await refreshToken(
    context,
    event.args.creator,
    event.args.tokenId,
    event.block.number,
    event.block.timestamp,
  )
})

ponder.on("MURIProtocol:ArtworkUriRemoved", async ({ event, context }) => {
  await refreshToken(
    context,
    event.args.creator,
    event.args.tokenId,
    event.block.number,
    event.block.timestamp,
  )
})

ponder.on("MURIProtocol:SelectedArtworkUriChanged", async ({ event, context }) => {
  const id = idOf(event.args.creator, event.args.tokenId)
  const existing = await context.db.find(muriTokens, { id })
  if (!existing) return
  await context.db
    .update(muriTokens, { id })
    .set({ selectedIndex: Number(event.args.newIndex), updatedAtBlock: event.block.number })
})

ponder.on("MURIProtocol:DisplayModeUpdated", async ({ event, context }) => {
  const id = idOf(event.args.creator, event.args.tokenId)
  const existing = await context.db.find(muriTokens, { id })
  if (!existing) return
  await context.db
    .update(muriTokens, { id })
    .set({ displayMode: Number(event.args.displayMode), updatedAtBlock: event.block.number })
})
