import type { Virtual } from "ponder"
import { tokenOwnership } from "ponder:schema"

/**
 * Shared writer for `token_ownership` (see ponder.schema.ts for the
 * per-source coverage boundary). Registered from SRV2NFT.ts
 * (SuperRareNFT:Transfer) and index.ts (FoundationNFT:Transfer). Every
 * Transfer, mint and burn included, upserts the row to `to`, so a present
 * row always holds the current owner (0x0 once burned).
 */

type PonderConfig = typeof import("../ponder.config").default
type PonderSchema = typeof import("../ponder.schema")
type Db = Virtual.Context<PonderConfig, PonderSchema, "SuperRareNFT:Transfer">["db"]

export type TokenOwnershipSource = "superrare-v2" | "foundation-shared"

export async function recordTransferOwner(
  db: Db,
  source: TokenOwnershipSource,
  event: {
    args: { to: `0x${string}`; tokenId: bigint }
    log: { address: `0x${string}`; logIndex: number }
    block: { number: bigint; timestamp: bigint }
    transaction: { hash: `0x${string}` }
  },
): Promise<void> {
  const { to, tokenId } = event.args
  const contract = event.log.address
  const current = {
    owner: to,
    source,
    lastBlock: event.block.number,
    logIndex: event.log.logIndex,
    blockTime: event.block.timestamp,
    txHash: event.transaction.hash,
  }
  await db
    .insert(tokenOwnership)
    .values({
      id: `${contract.toLowerCase()}-${tokenId.toString()}`,
      contract,
      tokenId,
      ...current,
    })
    .onConflictDoUpdate(current)
}
