import { ponder } from "ponder:registry"
import { mintCreators, mintArtistTokens } from "ponder:schema"

/**
 * Event handlers for the Mint protocol (Visualize Value).
 *
 * Two contract sources:
 *
 *   - `MintFactory:Created` — emitted on every per-artist collection
 *     deploy. Records (contract → deployer) into `mint_creators`. The
 *     row's PK is the clone address (globally unique), so the per-
 *     token mint handler below resolves the artist by primary-key
 *     lookup instead of scanning. Powers the `known_artists` view
 *     (UNION'd from this table) — every Mint deployer is automatically
 *     a "known artist" eligible for the web app's external-platform
 *     indexing.
 *
 *   - `MintCollection:TransferSingle` / `TransferBatch` — the dynamic-
 *     factory source in ponder.config.ts subscribes to every clone the
 *     Factory has emitted. We filter to mints (transfers from
 *     address(0)) and upsert one row per (contract, tokenId) into
 *     `mint_artist_tokens`. ERC-1155 editions emit many mints for the
 *     same tokenId; `onConflictDoNothing` collapses them to the first
 *     mint seen.
 *
 * Ordering: by the time a clone's TransferSingle is processed, its
 * `Created` event has already landed in `mint_creators` — events are
 * indexed in block + logIndex order, and a clone can't transfer
 * before it exists. If `find()` returns null we skip silently
 * (defense in depth; mirrors the find-or-skip pattern PND uses).
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

const tokenKey = (contract: string, tokenId: bigint) =>
  `${contract.toLowerCase()}-${tokenId.toString()}`

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
    // A re-org may re-emit; keep the first-seen row.
    .onConflictDoNothing()
})

ponder.on("MintCollection:TransferSingle", async ({ event, context }) => {
  const { from, id: tokenId } = event.args
  if (from !== ZERO_ADDRESS) return // only mints
  const contract = event.log.address

  const creatorRow = await context.db.find(mintCreators, { contract })
  if (!creatorRow) return

  await context.db
    .insert(mintArtistTokens)
    .values({
      id: tokenKey(contract, tokenId),
      creator: creatorRow.address,
      contract,
      tokenId,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      blockTime: event.block.timestamp,
    })
    // Editions share tokenId — keep the first mint row (typically
    // the artist's own initial _mint) as the canonical representative.
    .onConflictDoNothing()
})

ponder.on("MintCollection:TransferBatch", async ({ event, context }) => {
  const { from, ids } = event.args
  if (from !== ZERO_ADDRESS) return
  const contract = event.log.address

  const creatorRow = await context.db.find(mintCreators, { contract })
  if (!creatorRow) return

  for (const tokenId of ids) {
    await context.db
      .insert(mintArtistTokens)
      .values({
        id: tokenKey(contract, tokenId),
        creator: creatorRow.address,
        contract,
        tokenId,
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
        blockTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  }
})
