/**
 * INTENTIONALLY EMPTY in v2.
 *
 * The v1 lazy-index module (1858 lines) implemented the "scan-on-cache-miss"
 * pattern that drove most of v1's unexpected RPC bills. In v2 every read
 * goes to a permanent Postgres store that the worker keeps fresh; the
 * web app never refetches on miss and never fans out to chain.
 *
 * If you find yourself wanting to add a function here: stop. Either:
 *   - The data should be in a worker-owned table (artist_tokens,
 *     token_owners, etc.) — extend the worker, not this file.
 *   - The data is genuinely mutable live state — add a function to
 *     `lib/onchain.ts` with a pgCache wrapper.
 *
 * This file exists only because a few v1 modules still imported from
 * it during the cutover; the imports resolve to no-ops while we
 * complete the call-site sweep. Delete when the last importer is gone.
 */

export const LAZY_TTL = {} as const

// Re-export shapes so legacy imports don't crash at module-load time.
// These are read-only no-ops; nothing in v2 calls them.
export type SortableRef = {
  contract: `0x${string}`
  tokenId: string
  creator: `0x${string}`
  collectionName: string | null
  blockNumber: bigint
  logIndex: number
}

export const readFoundationArtistTokens = async (
  _artist: string,
): Promise<{ refs: SortableRef[]; lastIndexedAt: Date } | null> => null

export const writeFoundationArtistTokens = async (
  _artist: string,
  _refs: ReadonlyArray<unknown>,
): Promise<void> => {}

export const isFresh = (_at: Date, _ttlMs: number): boolean => false
