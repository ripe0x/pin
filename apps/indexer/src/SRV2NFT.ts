import { ponder } from "ponder:registry"
import { srv2ArtistTokens } from "ponder:schema"
import { classifyTransfer } from "./ownership"
import { recordTransferOwner } from "./tokenOwnership"

/**
 * SuperRare V2 shared 1/1 NFT contract. Mint = Transfer(from=0x0).
 * SR mints directly to the artist, so `to` IS the creator: no follow-
 * up read.
 *
 * Every Transfer (mint, sale, gift, burn) also moves `token_ownership`.
 * The subscription starts below the contract's deploy block, so SR V2
 * ownership there is complete.
 */

ponder.on("SuperRareNFT:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args
  await recordTransferOwner(context.db, "superrare-v2", event)

  if (classifyTransfer(from, to) !== "mint") return
  const contract = event.log.address
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
