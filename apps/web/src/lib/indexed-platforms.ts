/**
 * Source of truth for the EVM platforms PND indexes for an artist's
 * work. The Catalog import flow ("Pre-fill from your indexed work") pulls
 * its prefill from these and these only — anything an artist minted off
 * this list won't appear in the planner and must be added manually.
 *
 * Mirrors:
 *   - apps/worker/src/scanners/*  (where these mints get scanned)
 *   - apps/indexer/ponder.config.ts (Foundation + SuperRare shared)
 *   - lib/import-sources/pnd-indexed.ts (the SQL union)
 *
 * Keep this file in sync with those if you add a new platform — the
 * tooltip on /catalog/[address] reads from here.
 */
export const INDEXED_PLATFORM_NAMES = [
  "Foundation",
  "Manifold",
  "Mint",
  "SuperRare",
  "Transient Labs",
] as const

export type IndexedPlatformName = (typeof INDEXED_PLATFORM_NAMES)[number]
