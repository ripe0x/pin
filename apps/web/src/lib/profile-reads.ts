import "server-only"
import { sql } from "./db"
import { INDEXER_SCHEMA } from "./indexer-schema"
import { getCollectorTokens, type CollectorHolding } from "./reads"
import { chooseDisplayMedia, getDisplayMedia, type DisplayMedia } from "./display-media"
import { getTokenMediaFromMetadata, type TokenMetadataMedia } from "./indexer-queries"
import { readEnsIdentities } from "./ens-identity-store"
import { getOpenAuctions, type AuctionShelfCard } from "./landing-auctions"
import { type CollectedCard, type CollectedPage } from "./profile-collected"

/**
 * Reads behind the unified profile's Available and Collected tabs (#299).
 * Postgres only: no ownerOf, getLogs, multicall or wallet-NFT API on the
 * render or pagination path. Every read degrades instead of throwing, so a
 * cold database renders an honest "could not load" state, not a 500.
 */

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * Creator PND attributes each token to, keyed `${contract}:${tokenId}`.
 * Same sources and precedence as an artist's refs (artist-token-refs.ts):
 * the worker's artist_tokens, then Ponder's Foundation and SR V2 shared
 * 1/1s. All three are primary-key / (contract, token_id) index lookups.
 */
async function getTokenCreators(
  refs: Array<{ contract: string; tokenId: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!sql || refs.length === 0) return out
  const contracts = refs.map((r) => r.contract.toLowerCase())
  const tokenIds = refs.map((r) => r.tokenId)
  const s = INDEXER_SCHEMA
  const rows = (await sql.unsafe(
    `SELECT DISTINCT ON (k.contract, k.token_id) k.contract, k.token_id, c.creator
       FROM unnest($1::text[], $2::text[]) AS k(contract, token_id)
       JOIN LATERAL (
         SELECT a.artist AS creator, 0 AS r FROM artist_tokens a
          WHERE a.contract = k.contract AND a.token_id = k.token_id
         UNION ALL
         SELECT lower(f.creator), 1 FROM ${s}.fnd_artist_tokens f
          WHERE f.contract = k.contract AND f.token_id = k.token_id::numeric
         UNION ALL
         SELECT lower(v.creator), 2 FROM ${s}.srv2_artist_tokens v
          WHERE v.contract = k.contract AND v.token_id = k.token_id::numeric
       ) c ON true
      ORDER BY k.contract, k.token_id, c.r`,
    [contracts, tokenIds],
  )) as Array<{ contract: string; token_id: string; creator: string }>
  for (const r of rows) out.set(`${r.contract}:${r.token_id}`, r.creator.toLowerCase())
  return out
}

/** Hydrate raw holdings into cards. Never throws; missing data renders as placeholders. */
export async function getHoldingCards(items: CollectorHolding[]): Promise<CollectedCard[]> {
  if (items.length === 0) return []
  const refs = items.map((h) => ({ contract: h.contract, tokenId: h.tokenId }))
  const [artwork, meta, creators] = await Promise.all([
    getDisplayMedia(refs).catch(() => new Map<string, DisplayMedia>()),
    getTokenMediaFromMetadata(refs).catch(() => new Map<string, TokenMetadataMedia>()),
    getTokenCreators(refs).catch((err) => {
      console.error("[profile] token creators read failed:", err)
      return new Map<string, string>()
    }),
  ])
  const identities = await readEnsIdentities(Array.from(new Set(creators.values()))).catch(
    () => new Map(),
  )
  return items.map((h) => {
    const key = `${h.contract.toLowerCase()}:${h.tokenId}`
    const tokenMeta = meta.get(key) ?? null
    const artist = creators.get(key) ?? null
    return {
      contract: h.contract,
      tokenId: h.tokenId,
      standard: h.standard,
      balance: h.balance,
      acquiredBlock: h.acquiredBlock.toString(),
      source: h.source,
      title: tokenMeta?.name ?? null,
      artwork:
        artwork.get(key) ??
        chooseDisplayMedia(tokenMeta, null, { contract: h.contract, tokenId: h.tokenId }),
      artist,
      artistLabel: artist ? (identities.get(artist)?.ensName ?? short(artist)) : null,
    }
  })
}

/**
 * One page of the Collected tab: holdings (#296's keyset read) plus card
 * data. Throws only when the holdings read itself fails; callers decide
 * whether that is a 500 (API) or a "could not load" panel (page).
 */
export async function getCollectedPage(
  wallet: string,
  opts: { cursor?: string | null; limit?: number; excludeOwnWorks?: boolean } = {},
): Promise<CollectedPage> {
  const page = await getCollectorTokens(wallet, opts)
  return {
    items: await getHoldingCards(page.items),
    total: page.total,
    nextCursor: page.nextCursor,
    coverage: page.coverage,
  }
}

/**
 * Open PND auctions this address is selling, soonest-ending first. A
 * filter over the cached site-wide open-auction list (/auctions, 30 s), so
 * it adds no query per profile view. Null when that list can't be built.
 */
export async function getSellerOpenAuctions(address: string): Promise<AuctionShelfCard[] | null> {
  const all = await getOpenAuctions().catch((err) => {
    console.error("[profile] open auctions read failed:", err)
    return null
  })
  if (!all) return null
  const lower = address.toLowerCase()
  const now = Math.floor(Date.now() / 1000)
  return all.filter(
    (a) => a.seller.toLowerCase() === lower && (a.endTime === 0 || a.endTime > now),
  )
}
