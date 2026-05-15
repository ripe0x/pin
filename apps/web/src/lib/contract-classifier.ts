import {
  FOUNDATION_NFT,
  NFT_MARKET,
  SUPERRARE_V2_NFT,
  SUPERRARE_BAZAAR,
  TL_AUCTION_HOUSE,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"

/**
 * Pure classifier mapping a per-contract row from `getArtistContractMap`
 * (plus an optional platform hint from the multi-platform fan-out) to a
 * typed `ContractMapEntry` for the Artist Dependency Report.
 *
 * No I/O. No address lookups beyond the static `@pin/addresses`
 * constants. Easy to unit-test with fixtures.
 *
 * Classification rules:
 *   1. Address matches a known platform contract (FOUNDATION_NFT,
 *      SUPERRARE_V2_NFT, NFT_MARKET, etc.) → labeled by the registry.
 *      Confidence = Known.
 *   2. Row carries a `collectionCreator` matching the artist (from a
 *      Foundation V1/V2 factory clone) → Artist-owned contract,
 *      Detected.
 *   3. Row carries a `collectionCreator` not matching the artist →
 *      Shared creator contract, Detected (the artist minted on someone
 *      else's clone — unusual but possible).
 *   4. The caller marks this row as the artist's Sovereign auction
 *      house (`isSovereignHouse: true`) → PND auction contract.
 *      Confidence = Known because the row comes from `pnd_houses`.
 *   5. Anything else → Unknown contract.
 */

const EQ = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

const FOUNDATION_NFT_ADDR = FOUNDATION_NFT[MAINNET_CHAIN_ID]
const NFT_MARKET_ADDR = NFT_MARKET[MAINNET_CHAIN_ID]
const SR_V2_NFT_ADDR = SUPERRARE_V2_NFT[MAINNET_CHAIN_ID]
const SR_BAZAAR_ADDR = SUPERRARE_BAZAAR[MAINNET_CHAIN_ID]
const TL_AH_ADDR = TL_AUCTION_HOUSE[MAINNET_CHAIN_ID]

export type ContractRow = {
  contract: string
  tokenCount: number
  /** From `fnd_collections.creator` if the contract was deployed via a
   * Foundation V1/V2 factory; null for the shared FoundationNFT
   * contract and for non-Foundation contracts. */
  collectionCreator?: string | null
  /** From `fnd_collections.kind`: "1of1" | "drop". */
  collectionKind?: string | null
  collectionName?: string | null
  collectionSymbol?: string | null
  /** Hint from the multi-platform fan-out in chip 2. When set, the
   * classifier prefers this over guessing. */
  platform?: PlatformHint | null
  /** Set true when the caller is feeding the artist's own Sovereign
   * auction house as a contract row (see chip 3 orchestrator). */
  isSovereignHouse?: boolean
}

export type PlatformHint =
  | "foundation"
  | "manifold"
  | "mint"
  | "superrareV2"
  | "transient"
  | "sovereign"

export type ContractType =
  | "artist-owned"
  | "shared-creator"
  | "platform"
  | "pnd-auction"
  | "unknown"

export type Confidence = "Known" | "Detected" | "NeedsReview" | "Unknown"

export type ContractMapEntry = {
  contract: string
  tokenCount: number
  type: ContractType
  label: string
  confidence: Confidence
  system: string | null
  name: string | null
  kind: "1of1" | "drop" | null
  note: string
  /** True iff the artist has declared this contract in the on-chain
   * CatalogRegistry. Independent of `confidence` — a contract can
   * be both auto-detected (Known/Detected confidence) AND declared. */
  declaredInRegistry: boolean
}

const LABELS: Record<ContractType, string> = {
  "artist-owned": "Artist-owned contract",
  "shared-creator": "Shared creator contract",
  platform: "Platform contract",
  "pnd-auction": "Artist-owned auction contract",
  unknown: "Unknown contract",
}

const PLATFORM_SYSTEM_NAMES: Record<PlatformHint, string> = {
  foundation: "Foundation",
  manifold: "Manifold",
  mint: "Mint",
  superrareV2: "SuperRare",
  transient: "Transient",
  sovereign: "PND",
}

export function classifyContract(
  row: ContractRow,
  artistAddress: string,
  declaredSet?: ReadonlySet<string>,
): ContractMapEntry {
  const contract = row.contract.toLowerCase()
  const kind: "1of1" | "drop" | null =
    row.collectionKind === "1of1" || row.collectionKind === "drop"
      ? row.collectionKind
      : null
  const declaredInRegistry = declaredSet?.has(contract) ?? false

  // Caller-flagged Sovereign auction house — surface as artist-owned.
  if (row.isSovereignHouse) {
    return {
      contract,
      tokenCount: row.tokenCount,
      type: "pnd-auction",
      label: LABELS["pnd-auction"],
      confidence: "Known",
      system: "PND",
      name: row.collectionName ?? null,
      kind,
      note: "Artist-owned auction house deployed via the PND factory.",
      declaredInRegistry,
    }
  }

  // 1. Known shared NFT contracts (tokens live here for many artists).
  if (EQ(contract, FOUNDATION_NFT_ADDR)) {
    return {
      contract,
      tokenCount: row.tokenCount,
      type: "shared-creator",
      label: LABELS["shared-creator"],
      confidence: "Known",
      system: "Foundation",
      name: "Foundation 1/1",
      kind,
      note: "Shared Foundation creator contract used by many artists.",
      declaredInRegistry,
    }
  }
  if (EQ(contract, SR_V2_NFT_ADDR)) {
    return {
      contract,
      tokenCount: row.tokenCount,
      type: "shared-creator",
      label: LABELS["shared-creator"],
      confidence: "Known",
      system: "SuperRare",
      name: "SuperRare V2",
      kind,
      note: "Shared SuperRare V2 creator contract.",
      declaredInRegistry,
    }
  }

  // 2. Known platform marketplaces (NFTs don't usually live here but
  //    might appear if the row leaked through).
  if (EQ(contract, NFT_MARKET_ADDR)) {
    return {
      contract,
      tokenCount: row.tokenCount,
      type: "platform",
      label: LABELS.platform,
      confidence: "Known",
      system: "Foundation",
      name: "Foundation Marketplace",
      kind,
      note: "Foundation marketplace contract.",
      declaredInRegistry,
    }
  }
  if (EQ(contract, SR_BAZAAR_ADDR)) {
    return {
      contract,
      tokenCount: row.tokenCount,
      type: "platform",
      label: LABELS.platform,
      confidence: "Known",
      system: "SuperRare",
      name: "SuperRare Bazaar",
      kind,
      note: "SuperRare marketplace contract.",
      declaredInRegistry,
    }
  }
  if (EQ(contract, TL_AH_ADDR)) {
    return {
      contract,
      tokenCount: row.tokenCount,
      type: "platform",
      label: LABELS.platform,
      confidence: "Known",
      system: "Transient",
      name: "Transient Auction House",
      kind,
      note: "Transient Labs auction house contract.",
      declaredInRegistry,
    }
  }

  // 3. Foundation-deployed clone (we have a `fnd_collections` row).
  if (row.collectionCreator) {
    const isArtistDeployed = EQ(row.collectionCreator, artistAddress)
    return {
      contract,
      tokenCount: row.tokenCount,
      type: isArtistDeployed ? "artist-owned" : "shared-creator",
      label: isArtistDeployed
        ? LABELS["artist-owned"]
        : LABELS["shared-creator"],
      confidence: "Detected",
      system: "Foundation",
      name: row.collectionName ?? null,
      kind,
      note: isArtistDeployed
        ? "Foundation clone deployed by this artist."
        : "Foundation clone deployed by another address.",
      declaredInRegistry,
    }
  }

  // 4. Platform hint from the fan-out (chip 2). When the platform
  //    adapter located these tokens but we don't have a registry match,
  //    surface the platform name with Detected confidence.
  if (row.platform) {
    const system = PLATFORM_SYSTEM_NAMES[row.platform]
    return {
      contract,
      tokenCount: row.tokenCount,
      type: "shared-creator",
      label: LABELS["shared-creator"],
      confidence: "Detected",
      system,
      name: row.collectionName ?? null,
      kind,
      note: `${system}-indexed contract; deployer not verified.`,
      declaredInRegistry,
    }
  }

  // 5. No match.
  return {
    contract,
    tokenCount: row.tokenCount,
    type: "unknown",
    label: LABELS.unknown,
    confidence: "Unknown",
    system: null,
    name: row.collectionName ?? null,
    kind,
    note: "PND could not identify this contract from its current registry.",
    declaredInRegistry,
  }
}

/**
 * Build a contract-map entry for a contract that was declared in the
 * artist's on-chain record but didn't surface from any platform-side
 * discovery (no Foundation tokens, no Manifold/SR/Transient match).
 * Surfaces as artist-owned with `Declared` confidence — the artist
 * personally attested to it.
 */
export function declaredOnlyEntry(contract: string): ContractMapEntry {
  return {
    contract: contract.toLowerCase(),
    tokenCount: 0,
    type: "artist-owned",
    label: LABELS["artist-owned"],
    confidence: "Detected",
    system: null,
    name: null,
    kind: null,
    note: "Declared by the artist in the on-chain catalog; tokens not enumerated by platform indexers.",
    declaredInRegistry: true,
  }
}
