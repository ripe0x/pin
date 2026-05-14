import type { Address } from "viem"

/**
 * Normalized shape for a single work pulled from an external artist
 * registry. Sources differ wildly in their native JSON, so each source's
 * adapter is responsible for mapping into this common shape.
 *
 * Token-id variants supported:
 *   - single:    tokenId set, tokenIdStart/End/tokenIds unset
 *   - range:     tokenIdStart + tokenIdEnd set (inclusive)
 *   - list:      tokenIds set (non-contiguous; rendered as N addToken ops)
 *
 * Works with no tokenId / no contractAddress are dropped during
 * normalization (physical, off-chain platforms like Flow/Tezos/Bitcoin).
 */
export type RawWork = {
  id: string                  // source-internal identifier (slug, etc) — used as React key
  title: string
  chainId: number             // 1 mainnet, 8453 base, 137 polygon, 33139 ape, etc.
  contract: Address
  tokenId?: bigint
  tokenIdStart?: bigint
  tokenIdEnd?: bigint
  tokenIds?: bigint[]
  editionInfo?: string
  year?: number
  /** Primary image URL — try this first. */
  imageUrl?: string
  /**
   * Fallback URL used if `imageUrl` fails to load (broken host, expired
   * cert, etc.). Sources typically populate this from an IPFS-pinned
   * mirror of the same artwork.
   */
  imageFallbackUrl?: string
  externalUrl?: string
}

/**
 * An import source describes "where does this artist publish their
 * canonical registry?" Adding a new artist = drop one new adapter and
 * register it in `index.ts`. The adapter is server-only so it can hit
 * arbitrary HTTPS endpoints without exposing them to the client.
 */
/**
 * A work present in the artist's registry that we recognized but can't
 * import — physical prints, Tezos/Flow/Bitcoin entries, anything without
 * a usable EVM contract+tokenId. Surfaced in the UI so the artist knows
 * the planner saw these and intentionally excluded them.
 */
export type SkippedWork = {
  id: string
  title: string
  reason: "off-chain" | "physical" | "non-evm-chain"
  blockchain?: string
  externalUrl?: string
}

export type ImportSource = {
  /** The artist's on-chain address. URL key + Catalog.sol authority. */
  artistAddress: Address
  /** Human-readable name for UI ("Bryan Brinkman"). */
  displayName: string
  /** Link back to the artist's own registry page for credit. */
  sourceUrl: string
  /** Fetch + normalize. Runs server-side. */
  fetchWorks: () => Promise<{ works: RawWork[]; skipped: SkippedWork[] }>
}

/**
 * One on-chain Catalog write, ready to be encoded as multicall input.
 * `addToken` is preferred over `addTokenRange` when start==end (cheaper
 * gas, cleaner event).
 */
export type CatalogOp =
  | {
      kind: "addToken"
      contract: Address
      tokenId: bigint
      /** Back-link to the source work(s) for UI grouping. */
      works: RawWork[]
    }
  | {
      kind: "addTokenRange"
      contract: Address
      start: bigint
      end: bigint
      works: RawWork[]
    }
  | {
      kind: "addContract"
      contract: Address
      /**
       * Source rows this consolidated `addContract` op replaces. Carries
       * through so the UI can still show what the artist is claiming
       * even when the on-chain call is a single whole-contract write.
       */
      works: RawWork[]
    }

/**
 * Output of `normalize()` — surfaces both the actionable ops and the
 * categorized rejections so the UI can show the artist exactly what
 * was filtered and why.
 */
export type NormalizedPlan = {
  ops: CatalogOp[]
  alreadyIndexed: RawWork[]     // covered by the existing Catalog
  nonMainnet: RawWork[]         // EVM chain but not mainnet (Polygon/Base/Ape)
  unparseable: RawWork[]        // had a contract but no usable tokenId
  /** Carries through whatever the source adapter classified as un-importable. */
  offChain: SkippedWork[]
}
