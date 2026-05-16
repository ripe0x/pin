import { ponder } from "ponder:registry"
import { srv2ArtistTokens } from "ponder:schema"

/**
 * Event handler for the SuperRare V2 shared 1/1 NFT contract.
 *
 * SR V2's mint flow mints directly to the artist's address, so the
 * `to` field of a Transfer-from-zero event identifies the creator
 * without any follow-up read. Replaces the web-side
 * `scanSrv2ArtistTokens` path and the `lazy_srv2_artist_tokens` table.
 *
 * SuperRare Spaces (per-artist contracts that share the same Bazaar
 * marketplace) are out of scope here — matches the prior lazy-scan
 * deferral. Spaces enumeration would require an additional source.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

ponder.on("SuperRareNFT:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args
  if (from !== ZERO_ADDRESS) return // only mints
  const contract = event.log.address
  await context.db
    .insert(srv2ArtistTokens)
    .values({
      id: `${contract.toLowerCase()}-${tokenId.toString()}`,
      creator: to,
      contract,
      tokenId,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      blockTime: event.block.timestamp,
    })
    // Re-orgs may re-emit the same mint; idempotent insert.
    .onConflictDoNothing()
})
