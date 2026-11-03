/**
 * Which "escape (blue)" document `/api/escape/[tokenId]` may assemble.
 *
 * The renderer is never taken from the request. The caller names a
 * collection (or gets the default one); the collection must be one this
 * site indexes, its own renderer must have the escape shape, and the token
 * id must be one the collection has (or could preview). Anything else
 * resolves to null and the route answers 404.
 *
 * Pure, with every lookup injected, so the rules are testable without a
 * chain or a database. The route wires the real lookups.
 */
import { isAddress, type Address } from "viem"

export type EscapeCollectionView = { renderer: string; minted: bigint }

export type EscapeResolveDeps = {
  /** Collection used when the request names none (the launch collection). */
  defaultCollection: string | null
  /** Indexed-collection lookup; null for anything that is not a PND collection. */
  getCollection(address: Address): Promise<EscapeCollectionView | null>
  isEscapeRenderer(renderer: Address): Promise<boolean>
  /** Whether `tokenId` was ever minted on `collection` (tokenSeed answers). */
  tokenExists(collection: Address, tokenId: bigint): Promise<boolean>
}

export type EscapeTarget = { collection: Address; renderer: Address; tokenId: bigint }

const TOKEN_ID_RE = /^\d{1,78}$/

export async function resolveEscapeTarget(
  input: { tokenId: string; collection: string | null; renderer: string | null },
  deps: EscapeResolveDeps,
): Promise<EscapeTarget | null> {
  if (!TOKEN_ID_RE.test(input.tokenId)) return null
  const tokenId = BigInt(input.tokenId)

  const asked = input.collection ?? deps.defaultCollection
  if (!asked || !isAddress(asked, { strict: false })) return null
  const collection = asked.toLowerCase() as Address

  const view = await deps.getCollection(collection)
  if (!view || !isAddress(view.renderer, { strict: false })) return null
  const renderer = view.renderer.toLowerCase() as Address

  // A legacy `?renderer=` is accepted only as a restatement of the
  // collection's own renderer, never as a substitute for it.
  if (input.renderer !== null && input.renderer.toLowerCase() !== renderer) return null

  if (!(await deps.isEscapeRenderer(renderer))) return null

  // Sequential ids run 1..minted; id 1 is also the pre-mint preview the
  // collection page shows. Anything past that must have been minted.
  if (tokenId < 1n) return null
  const previewCeiling = view.minted > 1n ? view.minted : 1n
  if (tokenId > previewCeiling && !(await deps.tokenExists(collection, tokenId))) return null

  return { collection, renderer, tokenId }
}

/** The URL a page embeds for one escape token's document. */
export function escapeArtworkPath(tokenId: bigint, collection: string): string {
  return `/api/escape/${tokenId.toString()}?collection=${collection.toLowerCase()}`
}

/** Sandbox policy for the assembled document. It runs inline script (and
 *  data: script tags it gunzips into inline ones), draws an image, and
 *  loads its audio stems; in hi-res mode the image and stems are Arweave
 *  URLs fetched by Tone.js, so connect/media/img allow Arweave and inline
 *  data, and nothing else. */
export const ESCAPE_DOCUMENT_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "worker-src blob: data:",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https://arweave.net https://*.arweave.net",
  "media-src data: blob: https://arweave.net https://*.arweave.net",
  "connect-src data: blob: https://arweave.net https://*.arweave.net",
  "font-src data:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")
