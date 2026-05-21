import "server-only"
import type { Address } from "viem"
import type { ImportSource, RawWork, SkippedWork } from "./types.ts"
import { mapBrinkmanArtwork, type BrinkmanArtwork } from "./brinkman-map.ts"

/**
 * Adapter for Bryan Brinkman's self-published registry at
 * https://bryanbrinkman.com/registry. Backed by a JSON-LD DataFeed at
 * /api/artworks that lists 272 works with normalized contract/tokenId
 * fields. Mainnet-only entries (chainId 1) make it into the planner;
 * anything on Polygon/Base/Ape/Flow/Tezos/Bitcoin is filtered upstream
 * in `normalize()` so the artist sees it in the "skipped" count.
 *
 * Pure mapping logic lives in `brinkman-map.ts` so it's importable from
 * tests without dragging in `server-only`.
 */

const BRINKMAN_ADDRESS = "0x1e8E749b2B578E181Ca01962e9448006772b24a2" as Address // brinkman.eth (resolved 2026-05-14)
const BRINKMAN_API = "https://bryanbrinkman.com/api/artworks"

type BrinkmanFeed = {
  totalItems?: number
  artworks?: BrinkmanArtwork[]
}

export async function fetchBrinkmanWorks(): Promise<{
  works: RawWork[]
  skipped: SkippedWork[]
}> {
  const res = await fetch(BRINKMAN_API, {
    headers: { accept: "application/json" },
    // Brinkman updates this feed occasionally but it's static-ish; an
    // hour of caching is fine and saves us hammering his host on every
    // page load.
    next: { revalidate: 60 * 60 },
  })
  if (!res.ok) {
    throw new Error(`brinkman.com/api/artworks returned ${res.status}`)
  }
  const data = (await res.json()) as BrinkmanFeed
  const items = data.artworks ?? []
  const works: RawWork[] = []
  const skipped: SkippedWork[] = []
  for (const raw of items) {
    const mapped = mapBrinkmanArtwork(raw)
    if (!mapped) continue
    if (mapped.kind === "work") works.push(mapped.work)
    else skipped.push(mapped.skip)
  }
  return { works, skipped }
}

export const brinkmanSource: ImportSource = {
  id: "brinkman",
  artistAddress: BRINKMAN_ADDRESS,
  displayName: "Bryan Brinkman",
  sourceUrl: "https://bryanbrinkman.com/registry",
  fetchWorks: fetchBrinkmanWorks,
}
