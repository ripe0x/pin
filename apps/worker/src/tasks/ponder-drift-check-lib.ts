/**
 * Pure logic for ponder-drift-check.ts, split out so it can be unit
 * tested without a live DATABASE_URL (../db.ts opens a connection, and
 * exits the process, at import time).
 */

export type FactoryRow = {
  id: number
  address: string
  childAddressLocation: string | null
}

/**
 * Resolve a `ponder_sync.factories` row id by factory contract address
 * (case-insensitive) and, when given, the childAddressLocation that
 * disambiguates multiple watches on the same factory contract (Surface's
 * factory emits one child stream keyed on the collection address and one
 * keyed on the minter address, both from the same log).
 */
export function resolveFactoryId(
  factories: FactoryRow[],
  targetAddress: string,
  childAddressLocation?: string,
): number | undefined {
  const target = targetAddress.toLowerCase()
  return factories.find((f) => {
    if (f.address.toLowerCase() !== target) return false
    if (childAddressLocation && f.childAddressLocation !== childAddressLocation) return false
    return true
  })?.id
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
