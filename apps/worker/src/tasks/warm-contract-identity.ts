/**
 * Resolve immutable contract facts (name, symbol, supportsInterface)
 * for every contract referenced in Ponder + worker tables that doesn't
 * yet have a `contract_identity` row.
 *
 * Read sources: pnd_auctions.token_contract, fnd_auctions.nft_contract,
 * fnd_collections.collection, mint_creators.contract, tl_creators.contract,
 * artist_tokens.contract, catalog_contracts.contract_address.
 *
 * supportsInterface(0x80ac58cd) for ERC721, supportsInterface(0xd9b67a26)
 * for ERC1155, plus name/symbol and getCode.
 *
 * Rows are written once and never refreshed, so only REAL answers may be
 * cached (audit L4, #295): a revert or empty return is a real "no"; an
 * RPC failure (timeout, HTTP error, rate limit) is not (read-errors.ts).
 * If any of a contract's reads fails transiently, nothing is written for
 * it; it is retried after a backoff delay (scan_backoff, 20m, 40m, ...
 * capped at a day) and reported in TaskResult.errors. Candidates are
 * taken in a stable order, skipping backed-off ones, so a contract that
 * keeps timing out can't hold one of the batch slots every tick.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import type { TaskResult } from "../scheduler.ts"
import { erc721Abi, getAddress, type Address } from "viem"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"
import { settleRead } from "../read-errors.ts"
import { clearBackoff, loadBackoff, recordFailure, type BackoffPolicy } from "../backoff.ts"

// Minimal ERC-165 ABI inline — viem doesn't export an erc165Abi constant.
const erc165SupportsInterfaceAbi = [
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ type: "bool" }],
  },
] as const

const ERC721_INTERFACE_ID = "0x80ac58cd"
const ERC1155_INTERFACE_ID = "0xd9b67a26"
const BATCH_SIZE = 30
const TASK = "warm-contract-identity"
const BACKOFF: BackoffPolicy = { baseMs: 10 * 60_000, maxMs: 24 * 60 * 60_000 }

export async function warmContractIdentity(): Promise<TaskResult> {
  const candidates = (await sql.unsafe(
    `WITH all_contracts AS (
      SELECT lower(token_contract) AS address FROM ${INDEXER_SCHEMA}.pnd_auctions
      UNION SELECT lower(nft_contract) FROM ${INDEXER_SCHEMA}.fnd_auctions
      UNION SELECT lower(collection)   FROM ${INDEXER_SCHEMA}.fnd_collections
      UNION SELECT lower(contract)     FROM ${INDEXER_SCHEMA}.mint_creators
      UNION SELECT lower(contract)     FROM ${INDEXER_SCHEMA}.tl_creators
      UNION SELECT contract            FROM artist_tokens
      UNION SELECT lower(contract_address) FROM ${INDEXER_SCHEMA}.catalog_contracts
    )
    SELECT a.address
    FROM all_contracts a
    LEFT JOIN contract_identity ci ON ci.address = a.address
    LEFT JOIN scan_backoff b ON b.task = $1 AND b.scope = a.address
    WHERE ci.address IS NULL
      AND (b.retry_at IS NULL OR b.retry_at <= NOW())
    ORDER BY COALESCE(b.failures, 0), a.address
    LIMIT ${BATCH_SIZE}`,
    [TASK],
  )) as Array<{ address: string }>

  if (candidates.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const backoff = await loadBackoff(sql, TASK)
  let rpcCalls = 0
  let rowsWritten = 0
  const errors: string[] = []

  for (const { address } of candidates) {
    try {
      const addr = getAddress(address) as Address
      const [name, symbol, is721, is1155, bytecode] = await Promise.all([
        settleRead(
          client.readContract({ address: addr, abi: erc721Abi, functionName: "name" }) as Promise<string | null>,
          null,
        ),
        settleRead(
          client.readContract({ address: addr, abi: erc721Abi, functionName: "symbol" }) as Promise<string | null>,
          null,
        ),
        settleRead(client.readContract({
          address: addr, abi: erc165SupportsInterfaceAbi, functionName: "supportsInterface",
          args: [ERC721_INTERFACE_ID],
        }), false),
        settleRead(client.readContract({
          address: addr, abi: erc165SupportsInterfaceAbi, functionName: "supportsInterface",
          args: [ERC1155_INTERFACE_ID],
        }), false),
        // getCode has no "negative" error: an empty account returns 0x.
        settleRead(client.getCode({ address: addr }), undefined),
      ])
      rpcCalls += 5

      const failed = [name, symbol, is721, is1155, bytecode].find((r) => !r.ok)
      if (failed && !failed.ok) {
        const msg = failed.error instanceof Error
          ? failed.error.message.split("\n")[0]
          : String(failed.error)
        errors.push(`${address}: transient read failure, not cached: ${msg}`)
        await recordFailure(sql, TASK, backoff.get(address), address, msg, BACKOFF)
          .catch((err) => console.error(`[${TASK}] record failure ${address}:`, err))
        continue
      }
      const v = <T>(r: { ok: true; value: T } | { ok: false }) => (r.ok ? r.value : undefined) as T
      const hasBytecode = (v(bytecode) ?? "0x") !== "0x"

      const inserted = await sql`
        INSERT INTO contract_identity (address, name, symbol, has_bytecode, is_erc721, is_erc1155, fetched_at)
        VALUES (${address}, ${v(name)}, ${v(symbol)},
                ${hasBytecode}, ${v(is721) === true}, ${v(is1155) === true}, NOW())
        ON CONFLICT (address) DO UPDATE SET
          name = EXCLUDED.name, symbol = EXCLUDED.symbol,
          has_bytecode = EXCLUDED.has_bytecode,
          is_erc721 = EXCLUDED.is_erc721, is_erc1155 = EXCLUDED.is_erc1155,
          fetched_at = NOW()
      `
      rowsWritten += inserted.count
      if (backoff.has(address)) await clearBackoff(sql, TASK, [address]).catch(() => undefined)
    } catch (err) {
      console.error(`[${TASK}] ${address}:`, err)
      errors.push(`${address}: ${(err as Error).message}`)
    }
  }

  return { scopeCount: candidates.length, rpcCalls, rowsWritten, errors }
}
