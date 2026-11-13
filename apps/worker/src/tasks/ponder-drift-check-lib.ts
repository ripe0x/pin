/**
 * Pure logic for ponder-drift-check.ts, split out so it can be unit
 * tested without a live DATABASE_URL (../db.ts opens a connection, and
 * exits the process, at import time).
 */

export type FactoryRow = {
  id: number
  address: string
  childAddressLocation: string | null
  /** topic0 of the factory event this watch decodes (`factory->>'eventSelector'`). */
  eventSelector?: string | null
  chainId?: number | null
  fromBlock?: number | null
}

/**
 * One factory child stream as the indexer build declares it in
 * apps/indexer/ponder.config.ts. Ponder 0.16 stores each declared stream
 * as a `ponder_sync.factories` row whose JSON is
 * {type, chainId, address, eventSelector, childAddressLocation, fromBlock,
 * toBlock}. `ponder_sync` is shared by every indexer writing to the
 * database (ponder_v2..v5), so the same factory address can have several
 * rows, one per distinct build config.
 */
export type FactoryStream = {
  address: string
  childAddressLocation: string
  eventSelector: string
  chainId: number
}

/**
 * Every factories row describing this exact stream: address
 * (case-insensitive), childAddressLocation (Surface v1's factory has two
 * streams off one log, `topic2` = collection and `offset0` = minter), event
 * selector and chain. Sorted by id.
 */
export function factoryCandidates(factories: FactoryRow[], stream: FactoryStream): FactoryRow[] {
  const address = stream.address.toLowerCase()
  const selector = stream.eventSelector.toLowerCase()
  return factories
    .filter(
      (f) =>
        f.address.toLowerCase() === address &&
        f.childAddressLocation === stream.childAddressLocation &&
        (f.eventSelector ?? "").toLowerCase() === selector &&
        (f.chainId == null || Number(f.chainId) === stream.chainId),
    )
    .sort((a, b) => a.id - b.id)
}

export type StreamResolution =
  | { kind: "none" }
  | { kind: "resolved"; id: number }
  | { kind: "ambiguous"; ids: number[] }

/**
 * Pick the `ponder_sync.factories` row the configured INDEXER_SCHEMA's
 * build uses for one stream, deterministically:
 *
 * 1. Keep only rows matching the stream's address, childAddressLocation,
 *    event selector and chain. A build with a different factory event
 *    signature (an older SurfaceCreated, the superseded SurfaceFactoryV2)
 *    can never match.
 * 2. One row left: that is it. Builds with the same factory config share
 *    one row (Ponder upserts by the JSON), so this is the common case.
 * 3. Several rows (builds that differ only in fromBlock/toBlock): the row
 *    whose factory_addresses cover the most of this schema's own source
 *    rows (`overlapById`) is the one this schema was built from. A tie is
 *    reported as ambiguous instead of guessed, and the caller must not
 *    repair against it.
 */
export function resolveFactoryStream(
  candidates: FactoryRow[],
  overlapById: Map<number, number>,
): StreamResolution {
  if (candidates.length === 0) return { kind: "none" }
  if (candidates.length === 1) return { kind: "resolved", id: candidates[0]!.id }
  const scored = candidates
    .map((c) => ({ id: c.id, overlap: overlapById.get(c.id) ?? 0 }))
    .sort((a, b) => b.overlap - a.overlap || a.id - b.id)
  if (scored[0]!.overlap === scored[1]!.overlap) {
    return {
      kind: "ambiguous",
      ids: scored.filter((s) => s.overlap === scored[0]!.overlap).map((s) => s.id),
    }
  }
  return { kind: "resolved", id: scored[0]!.id }
}

/** Repair is opt-in: PONDER_DRIFT_REPAIR=1 (or "true"). Anything else is detect-and-alert. */
export function repairEnabled(raw: string | undefined): boolean {
  return raw === "1" || raw?.toLowerCase() === "true"
}

/** Addresses present in `source` but not in `existing`, lowercased, de-duplicated. */
export function missingAddresses(source: Iterable<string>, existing: Iterable<string>): string[] {
  const existingSet = new Set(Array.from(existing, (a) => a.toLowerCase()))
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of source) {
    const address = raw.toLowerCase()
    if (existingSet.has(address) || seen.has(address)) continue
    seen.add(address)
    out.push(address)
  }
  return out
}

export type FactoryAddressRow = {
  chain_id: number
  factory_id: number
  address: string
  block_number: string | number
}

/** Build the rows to insert into ponder_sync.factory_addresses for one factory. */
export function buildFactoryAddressRows(
  factoryId: number,
  chainId: number,
  rows: Array<{ address: string; blockNumber: string | number }>,
): FactoryAddressRow[] {
  return rows.map((r) => ({
    chain_id: chainId,
    factory_id: factoryId,
    address: r.address.toLowerCase(),
    block_number: r.blockNumber,
  }))
}
