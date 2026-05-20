import "server-only"
import type { Address } from "viem"
import type { ImportSource } from "./types.ts"
import { brinkmanSource } from "./brinkman.ts"
import { pndIndexedSource } from "./pnd-indexed.ts"

/**
 * Registry of import-source providers. Each provider knows how to
 * answer "does this artist have a source of type X?" and returns an
 * ImportSource bound to that artist, or null if not applicable.
 *
 *  - `brinkman`: only applicable when the artist address matches
 *    Bryan Brinkman's. Pulls from his self-published JSON-LD registry.
 *  - `pnd-indexed`: always applicable. Pulls from our own indexed
 *    data (`artist_tokens` + Ponder `*_artist_tokens` tables joined
 *    with `token_metadata`). Empty result for artists with no
 *    indexed rows — the planner UI handles the empty state.
 *
 * To add a new artist-specific source: drop a new adapter file and a
 * provider entry here. No other code changes.
 */
type Provider = (artist: Address) => ImportSource | null

const PROVIDERS: Provider[] = [
  (artist) =>
    artist.toLowerCase() === brinkmanSource.artistAddress.toLowerCase()
      ? brinkmanSource
      : null,
  (artist) => pndIndexedSource(artist),
]

export function listImportSourcesForArtist(artist: Address): ImportSource[] {
  const out: ImportSource[] = []
  for (const provider of PROVIDERS) {
    const s = provider(artist)
    if (s) out.push(s)
  }
  return out
}

export function getImportSource(
  artist: Address,
  sourceId: string,
): ImportSource | null {
  return (
    listImportSourcesForArtist(artist).find((s) => s.id === sourceId) ?? null
  )
}
