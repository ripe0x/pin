import "server-only"
import type { Address } from "viem"
import type { ImportSource } from "./types.ts"
import { brinkmanSource } from "./brinkman.ts"

/**
 * Registry of artists with a known external source we know how to
 * import. Keyed by lowercased on-chain address so the route handler can
 * look up by `/artist/<addr>/import` without case sensitivity.
 *
 * To onboard a new artist: drop a new adapter file in this directory
 * exposing an `ImportSource`, then add it here. No other code changes.
 */
const SOURCES: ImportSource[] = [brinkmanSource]

export const IMPORT_SOURCES: Record<string, ImportSource> = Object.fromEntries(
  SOURCES.map((s) => [s.artistAddress.toLowerCase(), s]),
)

export function getImportSource(addressOrEns: string): ImportSource | null {
  return IMPORT_SOURCES[addressOrEns.toLowerCase()] ?? null
}

export function getImportSourceByAddress(address: Address): ImportSource | null {
  return getImportSource(address)
}

export function listImportSources(): ImportSource[] {
  return [...SOURCES]
}
