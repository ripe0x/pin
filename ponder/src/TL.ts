import { ponder } from "ponder:registry"
import { tlCreators, tlArtistTokens } from "ponder:schema"

/**
 * Event handlers for Transient Labs (Universal Deployer + per-artist
 * clones).
 *
 * Two contract sources:
 *
 *   - `TLUniversalDeployer:ContractDeployed` — emitted on every
 *     ERC721TL / ERC1155TL clone deploy. Handler filters to
 *     `cType.startsWith("ERC721")` to skip ERC-1155 clones (matches
 *     the prior lazy-scan scope; ERC-1155 enumeration semantics
 *     differ and are deferred). Records (contract → sender) into
 *     `tl_creators`. The row's PK is the clone address (globally
 *     unique), so the per-token mint handler resolves the artist by
 *     primary-key lookup instead of scanning.
 *
 *   - `TLCollection:Transfer` — the dynamic-factory source in
 *     ponder.config.ts subscribes to every clone the Universal
 *     Deployer has emitted. We filter to mints (transfers from
 *     address(0)) and insert one row per (contract, tokenId) into
 *     `tl_artist_tokens`. For ERC-1155 clones the factory pattern
 *     still subscribes but they emit TransferSingle/Batch (not
 *     Transfer), so eth_getLogs returns zero matches — we don't see
 *     spurious events for non-ERC-721 clones.
 *
 * Find-or-skip on the per-token handler: if the clone's
 * `ContractDeployed` is pre-startBlock or was ERC-1155 (so we never
 * wrote its `tl_creators` row), skip silently rather than crashing
 * the indexer.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

const tokenKey = (contract: string, tokenId: bigint) =>
  `${contract.toLowerCase()}-${tokenId.toString()}`

ponder.on(
  "TLUniversalDeployer:ContractDeployed",
  async ({ event, context }) => {
    const { sender, deployedContract, implementation, cType, version } =
      event.args
    // Scope: ERC-721 clones only (preserves the prior lazy-scan
    // behavior). ERC1155TL contracts also flow through this deployer
    // but their token enumeration uses different events; tracking them
    // here would require also subscribing to TransferSingle/Batch on
    // the dynamic factory and resolving the creator from a different
    // table shape.
    if (!cType.startsWith("ERC721")) return

    await context.db
      .insert(tlCreators)
      .values({
        contract: deployedContract,
        sender,
        implementation,
        cType,
        version,
        firstSeenBlock: event.block.number,
        firstSeenTime: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      // A re-org may re-emit; keep the first-seen row.
      .onConflictDoNothing()
  },
)

ponder.on("TLCollection:Transfer", async ({ event, context }) => {
  const { from, tokenId } = event.args
  if (from !== ZERO_ADDRESS) return // only mints
  const contract = event.log.address

  // ERC-1155 clones are emitted by the same factory but we don't
  // write their `tl_creators` row — see the cType filter above. The
  // find-or-skip drops those silently. Same defense applies to any
  // pre-startBlock clone whose deploy event we missed.
  const creatorRow = await context.db.find(tlCreators, { contract })
  if (!creatorRow) return

  await context.db
    .insert(tlArtistTokens)
    .values({
      id: tokenKey(contract, tokenId),
      creator: creatorRow.sender,
      contract,
      tokenId,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      blockTime: event.block.timestamp,
    })
    // Re-orgs may re-emit a mint; idempotent insert.
    .onConflictDoNothing()
})
