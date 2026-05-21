import { ponder } from "ponder:registry"
import { tlCreators } from "ponder:schema"

/**
 * Transient Labs Universal Deployer discovery handler.
 *
 * v1 also subscribed to per-clone Transfer to populate `tl_artist_tokens`.
 * v2 drops those subscriptions; the worker's `scan-tl-clones` task does
 * the per-clone scanning, cursor-bounded, gated by known_artists.
 *
 * The `ContractDeployed` event is still indexed here because the worker
 * needs to know WHICH clones to scan.
 */

ponder.on(
  "TLUniversalDeployer:ContractDeployed",
  async ({ event, context }) => {
    const { sender, deployedContract, implementation, cType, version } =
      event.args
    // ERC-721 clones only — matches the worker's scan scope.
    if (!cType.startsWith("ERC721")) return

    await context.db
      .insert(tlCreators)
      .values({
        contract: deployedContract,
        sender, implementation, cType, version,
        firstSeenBlock: event.block.number,
        firstSeenTime: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing()
  },
)
