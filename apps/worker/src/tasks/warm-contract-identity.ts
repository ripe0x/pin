/**
 * Resolve immutable contract facts (name, symbol, supportsInterface)
 * for every contract referenced in Ponder + worker tables that doesn't
 * yet have a `contract_identity` row.
 *
 * Read sources: pnd_auctions.token_contract, fnd_auctions.nft_contract,
 * fnd_collections.collection, mint_creators.contract, tl_creators.contract,
 * artist_tokens.contract, catalog_contracts.contract_address.
 *
 * One multicall per batch of N contracts. supportsInterface(0x80ac58cd)
 * for ERC721, supportsInterface(0xd9b67a26) for ERC1155. `has_bytecode`
 * defaults to true if any read returns non-null; we only mark false on
 * explicit empty-code address.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import type { TaskResult } from "../scheduler.ts"
import { erc721Abi, getAddress, type Address } from "viem"

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
const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export async function warmContractIdentity(): Promise<TaskResult> {
  const candidates = (await sql.unsafe(
    `WITH all_contracts AS (
      SELECT lower(token_contract) AS address FROM ${INDEXER_SCHEMA}.pnd_auctions
      UNION SELECT lower(nft_contract) FROM ${INDEXER_SCHEMA}.fnd_auctions
      UNION SELECT lower(collection)   FROM ${INDEXER_SCHEMA}.fnd_collections
      UNION SELECT lower(contract)     FROM ${INDEXER_SCHEMA}.mint_creators
      UNION SELECT lower(contract)     FROM ${INDEXER_SCHEMA}.tl_creators
      UNION SELECT lower(contract)     FROM artist_tokens
      UNION SELECT lower(contract_address) FROM ${INDEXER_SCHEMA}.catalog_contracts
    )
    SELECT a.address
    FROM all_contracts a
    LEFT JOIN contract_identity ci ON ci.address = a.address
    WHERE ci.address IS NULL
    LIMIT ${BATCH_SIZE}`,
  )) as Array<{ address: string }>

  if (candidates.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  let rpcCalls = 0
  let rowsWritten = 0

  for (const { address } of candidates) {
    try {
      const addr = getAddress(address) as Address
      const [name, symbol, is721, is1155] = await Promise.all([
        client.readContract({ address: addr, abi: erc721Abi, functionName: "name" }).catch(() => null),
        client.readContract({ address: addr, abi: erc721Abi, functionName: "symbol" }).catch(() => null),
        client.readContract({
          address: addr, abi: erc165SupportsInterfaceAbi, functionName: "supportsInterface",
          args: [ERC721_INTERFACE_ID],
        }).catch(() => false),
        client.readContract({
          address: addr, abi: erc165SupportsInterfaceAbi, functionName: "supportsInterface",
          args: [ERC1155_INTERFACE_ID],
        }).catch(() => false),
      ])
      rpcCalls += 4

      const bytecode = await client.getCode({ address: addr }).catch(() => null)
      rpcCalls += 1
      const hasBytecode = (bytecode ?? "0x") !== "0x"

      await sql`
        INSERT INTO contract_identity (address, name, symbol, has_bytecode, is_erc721, is_erc1155, fetched_at)
        VALUES (${address}, ${name as string | null}, ${symbol as string | null},
                ${hasBytecode}, ${is721 as boolean}, ${is1155 as boolean}, NOW())
        ON CONFLICT (address) DO UPDATE SET
          name = EXCLUDED.name, symbol = EXCLUDED.symbol,
          has_bytecode = EXCLUDED.has_bytecode,
          is_erc721 = EXCLUDED.is_erc721, is_erc1155 = EXCLUDED.is_erc1155,
          fetched_at = NOW()
      `
      rowsWritten += 1
    } catch (err) {
      console.error(`[warm-contract-identity] ${address}:`, err)
    }
  }

  return { scopeCount: candidates.length, rpcCalls, rowsWritten }
}
