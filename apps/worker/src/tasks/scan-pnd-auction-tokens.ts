/**
 * Index tokens that are sold through PND/sovereign auctions but live on
 * contracts outside our pre-defined platform list (Foundation / SuperRare /
 * Mint / TL / Manifold).
 *
 * The gap this closes: an artist deploys their own ERC-721 and lists a piece
 * on their Sovereign Auction House. Ponder indexes the auction
 * (`pnd_auctions`), so the auction panel renders — but no per-platform
 * scanner ever touches that arbitrary contract, so `artist_tokens` /
 * `token_owners` / `token_metadata` stay empty and the token page shows no
 * artist tag, owner, provenance, or image.
 *
 * Fix: treat "appears as `token_contract` in `pnd_auctions`" as the index
 * signal. For each such (contract, token) not yet in `artist_tokens`, find
 * its mint — `Transfer(0x0 -> recipient, tokenId)` — and record the mint
 * RECIPIENT as the creator (the correct signal; the auction *seller* is just
 * whoever listed it and is NOT necessarily the artist).
 *
 * Attribution guard (option B): only write the artist when the mint
 * recipient lines up with reality — it equals one of the token's auction
 * sellers, or it's already a known artist. If a contract minted to some
 * third party we can't corroborate, we skip rather than assert a wrong
 * creator. The common case (artist mints to self, then lists) lines up and
 * is attributed; once a row lands, the existing machinery
 * (`scan-token-transfers`, `warm-metadata`, `resolveNewTokenOwner`) fills
 * owner / provenance / image with no further wiring.
 *
 * Bounded by design: only contracts with a PND auction are ever scanned
 * (never the open chain), the mint lookup is tokenId-topic-filtered, and we
 * stop as soon as the mint is found.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import { resolveNewTokenOwner } from "../scanners/resolve-owner.ts"
import { parseAbiItem, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g,
  "",
)

const ZERO = "0x0000000000000000000000000000000000000000"
// Shared 1/1 contracts are excluded: they're high-volume and their creators
// already come from Ponder's fnd_/srv2_ artist-token tables. A from-zero
// scan of these would be the exact unbounded scan v2 avoids.
const SHARED_CONTRACTS = [
  "0x3b3ee1931dc30c1957379fac9aba94d1c48a5405", // Foundation shared NFT
  "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0", // SuperRare shared NFT
]
const CHUNK = 9_500n // drpc free-tier eth_getLogs cap
const MAX_LOOKBACK_CHUNKS = 50n // mints sit shortly before the listing
const MAX_RPC_PER_TICK = 300 // wall-time guard; resumes next tick
const TASK = "scan-pnd-auction-tokens"

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)

type Needed = {
  contract: string
  token_id: string
  sellers: string[]
  anchor: string // earliest auction created_at_block
}

export async function scanPndAuctionTokens(): Promise<TaskResult> {
  if (!sql) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const artistRows = (await sql`SELECT address FROM known_artists`) as Array<{
    address: string
  }>
  const knownArtists = new Set(artistRows.map((r) => r.address.toLowerCase()))

  // Tokens auctioned on non-shared contracts that we haven't indexed yet.
  const needed = (await sql.unsafe(
    `SELECT lower(a.token_contract) AS contract,
            a.token_id::text       AS token_id,
            array_agg(DISTINCT lower(a.seller)) AS sellers,
            MIN(a.created_at_block)::text       AS anchor
       FROM ${INDEXER_SCHEMA}.pnd_auctions a
      WHERE lower(a.token_contract) <> ALL($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM artist_tokens t
           WHERE t.contract = lower(a.token_contract)
             AND t.token_id = a.token_id::text
        )
      GROUP BY 1, 2`,
    [SHARED_CONTRACTS],
  )) as Needed[]

  let rpcCalls = 0
  let rowsWritten = 0
  const contracts = new Set(needed.map((n) => n.contract))

  for (const n of needed) {
    if (rpcCalls >= MAX_RPC_PER_TICK) break

    const tokenId = BigInt(n.token_id)
    const anchor = BigInt(n.anchor)

    // Walk backward from the listing block in getLogs-sized chunks until we
    // hit the mint (it must precede the auction). tokenId is an indexed
    // topic, so each call is a precise point lookup.
    let mintTo: string | null = null
    let mintBlock: bigint | null = null
    let mintLogIndex = 0
    let toBlock = anchor
    for (let i = 0n; i < MAX_LOOKBACK_CHUNKS && toBlock > 0n; i++) {
      if (rpcCalls >= MAX_RPC_PER_TICK) break
      const fromBlock = toBlock > CHUNK ? toBlock - CHUNK + 1n : 0n
      await throttleRpc()
      try {
        const logs = await client.getLogs({
          address: n.contract as Address,
          event: transferEvent,
          args: { from: ZERO as Address, tokenId },
          fromBlock,
          toBlock,
        })
        rpcCalls += 1
        if (logs.length > 0) {
          const log = logs[0]
          mintTo = log.args.to?.toLowerCase() ?? null
          mintBlock = log.blockNumber ?? null
          mintLogIndex = log.logIndex ?? 0
          break
        }
      } catch (err) {
        console.error(`[${TASK}] getLogs ${n.contract} ${fromBlock}-${toBlock}:`, err)
        rpcCalls += 1
      }
      toBlock = fromBlock - 1n
    }

    if (!mintTo || mintBlock === null) continue

    // Attribution guard (option B): only credit a creator we can corroborate
    // against the auction seller(s) or the known-artist set.
    const linedUp = knownArtists.has(mintTo) || n.sellers.includes(mintTo)
    if (!linedUp) {
      console.warn(
        `[${TASK}] skip ${n.contract}/${n.token_id}: mint recipient ${mintTo} ` +
          `is neither a seller (${n.sellers.join(",")}) nor a known artist`,
      )
      continue
    }

    await sql`
      INSERT INTO artist_tokens
        (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
      VALUES
        (${mintTo}, ${n.contract}, ${n.token_id}, 'sovereign',
         ${mintBlock.toString()}::bigint, ${mintLogIndex}, NOW())
      ON CONFLICT (contract, token_id) DO NOTHING
    `
    rowsWritten += 1
    await resolveNewTokenOwner({
      sql,
      client,
      contract: n.contract,
      tokenId: n.token_id,
    }).catch(() => undefined)
  }

  return { scopeCount: contracts.size, rpcCalls, rowsWritten }
}
