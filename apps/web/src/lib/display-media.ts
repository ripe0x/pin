// No top-level `import "server-only"`: `chooseDisplayMedia` is pure and
// re-exported from `@pnd/media`, unit-tested there by the plain-Node test
// runner, which cannot load a server-only module (see
// indexer-freshness-status.ts for the same split). `getDisplayMedia` pulls
// in the two Postgres-backed reads with a dynamic import so loading this
// file for the pure function never touches them; both of those modules
// declare `server-only` themselves, so the actual database access stays
// server-only enforced.
import { chooseDisplayMedia as chooseDisplayMediaCore } from "@pnd/media"
import type { DisplayMedia, DisplayRef } from "@pnd/media"
import type { MediaDelivery } from "./media-delivery"
import type { TokenMetadataMedia } from "./indexer-queries"

export type { DisplayMedia }

function tokenMediaUrl(ref: DisplayRef): string {
  return `/api/media/token/${encodeURIComponent(ref.contract)}/${encodeURIComponent(ref.tokenId)}`
}

/**
 * Picks what to render for one token: a ready delivery derivative first,
 * else the metadata's image or animation URL, else nothing. Pure and
 * synchronous so it unit-tests without a database.
 */
export function chooseDisplayMedia(
  meta: Pick<TokenMetadataMedia, "imageUrl" | "animationUrl"> | null,
  delivery: MediaDelivery | null,
  ref: DisplayRef,
): DisplayMedia {
  return chooseDisplayMediaCore(meta, delivery, ref, { inlineUrl: tokenMediaUrl })
}

/**
 * Batch resolver for a page's worth of tokens: two Postgres reads total
 * (token_metadata, token_media_delivery), no chain reads. Keyed by
 * `${contract.toLowerCase()}:${tokenId}`.
 */
export async function getDisplayMedia(refs: DisplayRef[]): Promise<Map<string, DisplayMedia>> {
  const out = new Map<string, DisplayMedia>()
  if (refs.length === 0) return out
  const [{ getTokenMediaFromMetadata }, { getMediaDeliveries }] = await Promise.all([
    import("./indexer-queries"),
    import("./media-delivery"),
  ])
  const [metaMap, deliveryMap] = await Promise.all([
    getTokenMediaFromMetadata(refs).catch(() => new Map<string, TokenMetadataMedia>()),
    getMediaDeliveries(refs).catch(() => new Map<string, MediaDelivery>()),
  ])
  for (const ref of refs) {
    const key = `${ref.contract.toLowerCase()}:${ref.tokenId}`
    out.set(key, chooseDisplayMedia(metaMap.get(key) ?? null, deliveryMap.get(key) ?? null, ref))
  }
  return out
}
