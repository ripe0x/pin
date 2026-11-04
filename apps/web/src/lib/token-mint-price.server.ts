import "server-only"
import { sql } from "./db"
import { INDEXER_SCHEMA } from "./indexer-schema"
import { withTimeout } from "./indexer-queries"
import { mintPriceForToken, type IndexedSale, type TokenMintPrice } from "./token-mint-price"

const INDEXER_DISABLED = process.env.INDEXER_DISABLED === "1"

// `collection_sales` ships with the Surface indexer release; a web deploy
// can precede the schema that carries it (or point at one without it).
// Probe once, sticky once true, same pattern as surfaceTablesExist in
// indexer-queries.ts. A failed probe reads as absent and retries next call.
let salesTableSeen = false
async function salesTableExists(db: NonNullable<typeof sql>, schema: string): Promise<boolean> {
  if (salesTableSeen) return true
  try {
    const rows = (await db.unsafe(`SELECT to_regclass($1) IS NOT NULL AS ok`, [
      `${schema}.collection_sales`,
    ])) as Array<{ ok: boolean }>
    if (rows[0]?.ok) salesTableSeen = true
    return salesTableSeen
  } catch {
    return false
  }
}

/**
 * The primary mint price of one Surface token: the indexed Sold row whose
 * [firstTokenId, firstTokenId + quantity) span covers the id, divided per
 * token (lib/token-mint-price.ts). Pure SELECT, zero chain reads. Null when
 * the indexer is unavailable, the table does not exist in the configured
 * schema, or no indexed sale covers the id (minted by another minter, or
 * not indexed yet); the token page then shows nothing rather than a guess.
 */
export async function getTokenMintPrice(collection: string, tokenId: bigint): Promise<TokenMintPrice | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  const schema = INDEXER_SCHEMA
  if (!(await salesTableExists(db, schema))) return null
  return withTimeout(async () => {
    const rows = (await db.unsafe(
      `SELECT first_token_id::text AS first_token_id, quantity::text AS quantity,
              paid::text AS paid, block_number::text AS block_number, tx_hash
       FROM ${schema}.collection_sales
       WHERE collection = $1 AND first_token_id <= $2 AND first_token_id + quantity > $2
       ORDER BY block_number DESC
       LIMIT 5`,
      [collection.toLowerCase(), tokenId.toString()],
    )) as Array<{ first_token_id: string; quantity: string; paid: string; block_number: string; tx_hash: string }>
    const sales: IndexedSale[] = rows.map((r) => ({
      firstTokenId: BigInt(r.first_token_id),
      quantity: BigInt(r.quantity),
      paid: BigInt(r.paid),
      blockNumber: BigInt(r.block_number),
      txHash: r.tx_hash,
    }))
    return mintPriceForToken(sales, tokenId)
  })
}
