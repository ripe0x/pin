import "server-only"
import { sql } from "./db"

/**
 * Last-sale price lookup for a single token. v2 reads from Ponder
 * tables — no chain scans.
 *
 * Sources:
 *   - Foundation NFTMarket: ponder.fnd_sales (auction settlements +
 *     buy-now accepts; same row shape regardless).
 *   - Sovereign Auction House: ponder.pnd_auctions WHERE status='settled'.
 *
 * Sales on other marketplaces (OpenSea/Blur/SR/TL/etc.) aren't surfaced
 * — those venues aren't indexed in v2.
 */

const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export type LastSale = {
  priceWei: bigint
  blockTime: number
  source: "foundation" | "sovereign"
  txHash: string
}

export async function getLastSalePriceForToken(
  nftContract: string,
  tokenId: string,
  /** v1 callers passed a `creator` hint used by Sovereign's RPC fallback
   * to resolve the house via `houseOf(creator)`. v2 reads from Ponder
   * so the hint is unused — accept it for call-site compatibility. */
  _creator?: string | null,
): Promise<LastSale | null> {
  if (!sql) return null
  const lower = nftContract.toLowerCase()

  const [fnd, pnd] = await Promise.all([
    sql.unsafe(
      `SELECT price_wei::text AS price_wei, block_time::text AS block_time, tx_hash
       FROM ${schema}.fnd_sales
       WHERE lower(nft_contract) = $1 AND token_id::text = $2
       ORDER BY block_time DESC LIMIT 1`,
      [lower, tokenId],
    ) as Promise<Array<{ price_wei: string; block_time: string; tx_hash: string }>>,
    sql.unsafe(
      `SELECT amount::text AS price_wei, settled_at_time::text AS block_time,
              lifecycle_tx_hash AS tx_hash
       FROM ${schema}.pnd_auctions
       WHERE lower(token_contract) = $1 AND token_id::text = $2
         AND status = 'settled'
       ORDER BY settled_at_time DESC LIMIT 1`,
      [lower, tokenId],
    ) as Promise<Array<{ price_wei: string; block_time: string; tx_hash: string | null }>>,
  ])

  const fndSale = fnd[0]
    ? {
        priceWei: BigInt(fnd[0].price_wei),
        blockTime: Number(fnd[0].block_time),
        source: "foundation" as const,
        txHash: fnd[0].tx_hash,
      }
    : null
  const pndSale = pnd[0]
    ? {
        priceWei: BigInt(pnd[0].price_wei),
        blockTime: Number(pnd[0].block_time),
        source: "sovereign" as const,
        txHash: pnd[0].tx_hash ?? "",
      }
    : null

  if (fndSale && pndSale) {
    return fndSale.blockTime >= pndSale.blockTime ? fndSale : pndSale
  }
  return fndSale ?? pndSale
}

// Legacy named exports kept for v1 call-site compatibility. Both delegate
// to the unified read above.
export async function getFoundationLastSale(
  nftContract: string, tokenId: string,
): Promise<LastSale | null> {
  const sale = await getLastSalePriceForToken(nftContract, tokenId)
  return sale?.source === "foundation" ? sale : null
}

export async function getSovereignLastSale(
  nftContract: string, tokenId: string,
): Promise<LastSale | null> {
  const sale = await getLastSalePriceForToken(nftContract, tokenId)
  return sale?.source === "sovereign" ? sale : null
}
