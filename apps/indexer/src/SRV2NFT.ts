import { ponder } from "ponder:registry"
import { srv2ArtistTokens, tokenOwnership } from "ponder:schema"

/**
 * SuperRare V2 shared 1/1 NFT contract. Mint = Transfer(from=0x0).
 * SR mints directly to the artist, so `to` IS the creator — no follow-
 * up read.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

ponder.on("SuperRareNFT:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args
  const contract = event.log.address

  const current = {
    owner: to,
    source: "ponder-superrare-v2",
    coverageStatus: "complete",
    lastBlock: event.block.number,
    logIndex: event.log.logIndex,
    blockTime: event.block.timestamp,
    txHash: event.transaction.hash,
  }
  await context.db
    .insert(tokenOwnership)
    .values({
      id: `${contract.toLowerCase()}-${tokenId.toString()}`,
      contract,
      tokenId,
      ...current,
    })
    .onConflictDoUpdate(current)

  if (from !== ZERO_ADDRESS) return
  await context.db
    .insert(srv2ArtistTokens)
    .values({
      id: `${contract.toLowerCase()}-${tokenId.toString()}`,
      creator: to,
      contract, tokenId,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      blockTime: event.block.timestamp,
    })
    .onConflictDoNothing()
})
