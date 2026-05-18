import { ponder } from "ponder:registry"
import { mintCreators } from "ponder:schema"

/**
 * Mint protocol (Visualize Value) Factory discovery handler.
 *
 * v1 also subscribed to per-clone TransferSingle/TransferBatch to
 * populate `mint_artist_tokens`. v2 drops those subscriptions; the
 * worker's `scan-mint-clones` task does the per-clone scanning,
 * cursor-bounded, gated by known_artists.
 *
 * The `Created` event is still indexed here because the worker needs to
 * know WHICH clones to scan (and the `known_artists` view UNIONs
 * `mint_creators.address` to auto-promote Mint deployers).
 */

ponder.on("MintFactory:Created", async ({ event, context }) => {
  const { ownerAddress, contractAddress } = event.args
  await context.db
    .insert(mintCreators)
    .values({
      contract: contractAddress,
      address: ownerAddress,
      firstSeenBlock: event.block.number,
      firstSeenTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})
