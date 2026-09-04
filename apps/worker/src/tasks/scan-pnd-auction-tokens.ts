/**
 * Discover the mint recipient for arbitrary ERC-721 tokens listed through a
 * PND auction house. Progress is durable per token, so an absent or very old
 * mint never restarts the same archive ranges on every scheduler tick.
 */
import { parseAbiItem, padHex, toEventSelector, toHex, type Address } from "viem"
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import type { TaskResult } from "../scheduler.ts"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g,
  "",
)
const ZERO = "0x0000000000000000000000000000000000000000"
const SHARED_CONTRACTS = [
  "0x3b3ee1931dc30c1957379fac9aba94d1c48a5405",
  "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0",
]
const CHUNK = 9_500n
const MAX_RPC_PER_TICK = 50
const MAX_TOKENS_PER_TICK = 25
const TASK = "scan-pnd-auction-tokens"

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
const TRANSFER_TOPIC = toEventSelector(transferEvent)
const ZERO_TOPIC = padHex(ZERO as `0x${string}`, { size: 32 })

type Pending = {
  contract: string
  token_id: string
  sellers: string[]
  anchor_block: string
  next_to_block: string
}

type MintEvidence = {
  recipient: string
  blockNumber: bigint
  logIndex: number
}

export async function scanPndAuctionTokens(): Promise<TaskResult> {
  const artistRows = (await sql`SELECT address FROM known_artists`) as Array<{
    address: string
  }>
  const knownArtists = new Set(artistRows.map((row) => row.address.toLowerCase()))

  await sql.unsafe(
    `INSERT INTO pnd_token_discovery
       (contract, token_id, anchor_block, next_to_block, status, updated_at)
     SELECT lower(a.token_contract), a.token_id::text,
            MIN(a.created_at_block), MIN(a.created_at_block), 'pending', NOW()
       FROM ${INDEXER_SCHEMA}.pnd_auctions a
      WHERE lower(a.token_contract) <> ALL($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM artist_tokens t
           WHERE t.contract = lower(a.token_contract)
             AND t.token_id = a.token_id::text
        )
      GROUP BY lower(a.token_contract), a.token_id
     ON CONFLICT (contract, token_id) DO UPDATE SET
       anchor_block = LEAST(pnd_token_discovery.anchor_block, EXCLUDED.anchor_block),
       next_to_block = CASE
         WHEN pnd_token_discovery.attempts = 0
           THEN LEAST(pnd_token_discovery.next_to_block, EXCLUDED.next_to_block)
         ELSE pnd_token_discovery.next_to_block
       END,
       updated_at = NOW()`,
    [SHARED_CONTRACTS],
  )

  const pending = (await sql.unsafe(
    `SELECT d.contract, d.token_id, d.anchor_block::text,
            d.next_to_block::text,
            array_agg(DISTINCT lower(a.seller)) AS sellers
       FROM pnd_token_discovery d
       JOIN ${INDEXER_SCHEMA}.pnd_auctions a
         ON lower(a.token_contract) = d.contract
        AND a.token_id::text = d.token_id
      WHERE d.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM artist_tokens t
           WHERE t.contract = d.contract AND t.token_id = d.token_id
        )
      GROUP BY d.contract, d.token_id, d.anchor_block, d.next_to_block
      ORDER BY d.updated_at, d.contract, d.token_id
      LIMIT $1`,
    [MAX_TOKENS_PER_TICK],
  )) as Pending[]

  let rpcCalls = 0
  let rowsWritten = 0
  const etherscanKey = process.env.ETHERSCAN_API_KEY

  for (const token of pending) {
    let evidence: MintEvidence | null = null
    if (etherscanKey) {
      evidence = await findMintWithEtherscan(token, etherscanKey)
      rpcCalls += 1
      if (!evidence) {
        await markTerminal(token, "unsupported", "no ERC-721 mint Transfer found")
        continue
      }
    } else {
      if (rpcCalls >= MAX_RPC_PER_TICK) break
      const toBlock = BigInt(token.next_to_block)
      const fromBlock = toBlock >= CHUNK ? toBlock - CHUNK + 1n : 0n
      await throttleRpc()
      let logs
      try {
        logs = await client.getLogs({
          address: token.contract as Address,
          event: transferEvent,
          args: { from: ZERO as Address, tokenId: BigInt(token.token_id) },
          fromBlock,
          toBlock,
        })
      } catch (error) {
        await sql`
          UPDATE pnd_token_discovery
          SET last_error = ${String(error)}, updated_at = NOW()
          WHERE contract = ${token.contract} AND token_id = ${token.token_id}
        `
        throw error
      }
      rpcCalls += 1
      if (logs.length > 0) {
        const log = logs[0]
        if (log.args.to && log.blockNumber !== null) {
          evidence = {
            recipient: log.args.to.toLowerCase(),
            blockNumber: log.blockNumber,
            logIndex: log.logIndex ?? 0,
          }
        }
      } else if (fromBlock === 0n) {
        await markTerminal(token, "unsupported", "no ERC-721 mint Transfer found")
        continue
      } else {
        await sql`
          UPDATE pnd_token_discovery
          SET next_to_block = ${(fromBlock - 1n).toString()}::bigint,
              attempts = attempts + 1,
              last_error = NULL,
              updated_at = NOW()
          WHERE contract = ${token.contract} AND token_id = ${token.token_id}
        `
        continue
      }
    }

    if (!evidence) continue
    const attributed = knownArtists.has(evidence.recipient) || token.sellers.includes(evidence.recipient)
    if (!attributed) {
      await markTerminal(
        token,
        "unsupported",
        `mint recipient ${evidence.recipient} is not a known artist or auction seller`,
      )
      continue
    }

    await sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO artist_tokens
          (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
        VALUES
          (${evidence!.recipient}, ${token.contract}, ${token.token_id}, 'sovereign',
           ${evidence!.blockNumber.toString()}::bigint, ${evidence!.logIndex}, NOW())
        ON CONFLICT (contract, token_id) DO NOTHING
        RETURNING 1
      `
      rowsWritten += inserted.count
      await tx`
        UPDATE pnd_token_discovery
        SET status = 'found', attempts = attempts + 1,
            last_error = NULL, updated_at = NOW()
        WHERE contract = ${token.contract} AND token_id = ${token.token_id}
      `
    })
  }

  return {
    scopeCount: new Set(pending.map(({ contract }) => contract)).size,
    rpcCalls,
    rowsWritten,
  }
}

async function findMintWithEtherscan(
  token: Pending,
  apiKey: string,
): Promise<MintEvidence | null> {
  const params = new URLSearchParams({
    chainid: "1",
    module: "logs",
    action: "getLogs",
    fromBlock: "0",
    toBlock: token.anchor_block,
    address: token.contract,
    topic0: TRANSFER_TOPIC,
    topic0_1_opr: "and",
    topic1: ZERO_TOPIC,
    topic1_3_opr: "and",
    topic3: padHex(toHex(BigInt(token.token_id)), { size: 32 }),
    page: "1",
    offset: "10",
    apikey: apiKey,
  })
  const response = await fetch(`https://api.etherscan.io/v2/api?${params}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Etherscan logs HTTP ${response.status}`)
  const body = await response.json() as {
    status: string
    message: string
    result: string | Array<{
      topics: string[]
      blockNumber: string
      logIndex: string
    }>
  }
  if (body.status === "0") {
    if (typeof body.result === "string" && /no records found/i.test(body.result)) return null
    throw new Error(`Etherscan logs error: ${body.message}: ${String(body.result)}`)
  }
  if (!Array.isArray(body.result) || body.result.length === 0) return null
  const log = body.result[0]
  const toTopic = log.topics[2]
  if (!toTopic) throw new Error("Etherscan Transfer log missing recipient topic")
  return {
    recipient: `0x${toTopic.slice(-40)}`.toLowerCase(),
    blockNumber: BigInt(log.blockNumber),
    logIndex: Number(BigInt(log.logIndex || "0x0")),
  }
}

async function markTerminal(
  token: Pick<Pending, "contract" | "token_id">,
  status: "unsupported" | "failed",
  error: string,
): Promise<void> {
  await sql`
    UPDATE pnd_token_discovery
    SET status = ${status}, attempts = attempts + 1,
        last_error = ${error}, updated_at = NOW()
    WHERE contract = ${token.contract} AND token_id = ${token.token_id}
  `
}
