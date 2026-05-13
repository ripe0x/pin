import "server-only"
import { sql } from "./db"

/**
 * Persistent contract identity index. See `db/migrations/021_contract_identity.sql`
 * for the schema rationale. Mirrors `token-metadata-store.ts`: rows live
 * forever once written; first lookup pays the on-chain probe cost, every
 * subsequent read is a single Postgres point read.
 *
 * Identity here = name, symbol, has_bytecode, and ERC-{721,1155} flags.
 * totalSupply is the one mutable field on the original `/api/contract-info`
 * response and is deliberately NOT stored here — the API route layers a
 * short-TTL pgCache on top for that one column.
 *
 * Read API:
 *   readContractIdentity(address): returns the stored row, or null if the
 *   address has never been probed. A row with name=null and has_bytecode=
 *   false means "we tried, no bytecode" — treat as resolved-empty, NOT a
 *   reason to re-probe.
 *
 * Write API:
 *   writeContractIdentity(address, fields): upserts. Fire-and-forget so
 *   the user-facing path never waits on Postgres write latency.
 *
 * When DATABASE_URL is unset (local dev with no pg), both functions no-op
 * (read returns null, write swallows). Caller falls through to live RPC
 * resolution on every request — same kill-switch behavior as `pgCache`
 * and `token-metadata-store`.
 */

export type StoredContractIdentity = {
  name: string | null
  symbol: string | null
  hasBytecode: boolean
  isERC721: boolean
  isERC1155: boolean
  fetchedAt: Date
}

export async function readContractIdentity(
  address: string,
): Promise<StoredContractIdentity | null> {
  if (!sql) return null
  try {
    const rows = await sql<
      Array<{
        name: string | null
        symbol: string | null
        has_bytecode: boolean
        is_erc721: boolean
        is_erc1155: boolean
        fetched_at: Date
      }>
    >`
      SELECT name, symbol, has_bytecode, is_erc721, is_erc1155, fetched_at
      FROM contract_identity
      WHERE address = ${address.toLowerCase()}
      LIMIT 1
    `
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      name: r.name,
      symbol: r.symbol,
      hasBytecode: r.has_bytecode,
      isERC721: r.is_erc721,
      isERC1155: r.is_erc1155,
      fetchedAt: r.fetched_at,
    }
  } catch {
    return null
  }
}

export type WriteContractIdentityInput = {
  name: string | null
  symbol: string | null
  hasBytecode: boolean
  isERC721: boolean
  isERC1155: boolean
}

export function writeContractIdentity(
  address: string,
  input: WriteContractIdentityInput,
): void {
  if (!sql) return
  void sql`
    INSERT INTO contract_identity
      (address, name, symbol, has_bytecode, is_erc721, is_erc1155, fetched_at)
    VALUES (
      ${address.toLowerCase()},
      ${input.name},
      ${input.symbol},
      ${input.hasBytecode},
      ${input.isERC721},
      ${input.isERC1155},
      NOW()
    )
    ON CONFLICT (address) DO UPDATE
      SET name = EXCLUDED.name,
          symbol = EXCLUDED.symbol,
          has_bytecode = EXCLUDED.has_bytecode,
          is_erc721 = EXCLUDED.is_erc721,
          is_erc1155 = EXCLUDED.is_erc1155,
          fetched_at = EXCLUDED.fetched_at
  `.catch(() => {})
}
