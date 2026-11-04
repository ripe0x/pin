/**
 * The attribution roster's pure rules (issue #261), kept free of
 * server-only imports so they are unit-testable. The SELECTs live in
 * lib/attribution.server.ts:getAttributionRoster.
 *
 * A Catalog claim on its own is self-asserted: anyone can add any contract
 * to their own Catalog record. So a claim is only ever credited when the
 * collection side vouches for the claimant too:
 *
 * - v1: the owner lists the creator (Surface v1 `CreatorListed`, indexed
 *   into `collection_creators` from ponder_v5) and the creator claims the
 *   collection in their Catalog (`catalog_contracts`). Listed AND claimed is
 *   confirmed, exactly what the v1 collection's isConfirmedCreator computes
 *   onchain; listed but not claimed is shown unconfirmed.
 * - primitive v2: there is no creator list (setCreators/isListedCreator
 *   were removed), so the only claim that can be vouched for is the
 *   owner's own: a claim counts only when the claimant is the collection's
 *   owner (the current owner, or the owner recorded at launch once the
 *   collection is renounced). Every other claim is hidden.
 * - v1 on a schema without `collection_creators` (ponder_v4): no roster at
 *   all. The owner side cannot be read, and a Catalog-only roster would
 *   credit strangers.
 */
import type { Address } from "viem"

export type CreatorEntry = { creator: Address; confirmed: boolean }

/** Where a roster came from:
 *  - "listed": v1, the owner's indexed listing intersected with Catalog claims.
 *  - "owner-claim": primitive v2, the owner's own Catalog claim.
 *  - "none": nothing creditable could be read (indexer unavailable, or a v1
 *    collection on a schema without the listing). */
export type RosterBasis = "listed" | "owner-claim" | "none"

export type AttributionRoster = { basis: RosterBasis; entries: CreatorEntry[] }

export type ListedCreatorRow = { creator: string; listed: boolean }

const ZERO = "0x0000000000000000000000000000000000000000"
const lc = (a: string) => a.toLowerCase()

/** Unique by lowercase address, first occurrence wins, order kept. */
function uniq(addrs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of addrs) {
    const k = lc(a)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

export type RosterInput =
  | {
      kind: "v1"
      /** The owner's indexed listing; null when the schema has no
       *  collection_creators table. */
      listed: readonly ListedCreatorRow[] | null
      claims: readonly string[]
    }
  | {
      kind: "v2"
      claims: readonly string[]
      /** The live owner() (zero once renounced). */
      owner: string | null
      /** The owner recorded at launch, used once the live owner is zero. */
      launchOwner: string | null
    }

/** The owners whose own Catalog claim credits a v2 collection: the live
 *  owner, or once renounced (owner() == 0) the launch owner. Zero and
 *  missing addresses never count. */
export function v2CreditableOwners(owner: string | null, launchOwner: string | null): string[] {
  const live = owner && lc(owner) !== ZERO ? lc(owner) : null
  if (live) return [live]
  const launch = launchOwner && lc(launchOwner) !== ZERO ? lc(launchOwner) : null
  return launch ? [launch] : []
}

export function buildAttributionRoster(input: RosterInput): AttributionRoster {
  const claims = uniq(input.claims)
  if (input.kind === "v2") {
    const owners = new Set(v2CreditableOwners(input.owner, input.launchOwner))
    const entries = claims.filter((c) => owners.has(c)).map((c) => ({ creator: c as Address, confirmed: true }))
    return { basis: "owner-claim", entries }
  }
  if (input.listed === null) return { basis: "none", entries: [] }
  const claimed = new Set(claims)
  const listed = uniq(input.listed.filter((r) => r.listed).map((r) => r.creator))
  return {
    basis: "listed",
    entries: listed.map((c) => ({ creator: c as Address, confirmed: claimed.has(c) })),
  }
}

/**
 * Who a collection's byline credits: the confirmed creators, else the
 * owner. A listed creator who has not claimed is shown on the roster as
 * unconfirmed but never put in the headline credit.
 */
export function creditedArtists(entries: readonly CreatorEntry[], owner: Address): Address[] {
  const confirmed = entries.filter((e) => e.confirmed).map((e) => e.creator)
  return confirmed.length > 0 ? confirmed : [owner]
}
