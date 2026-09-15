/**
 * Pre-mint collection page hero: which source to show before any token is
 * minted. Cover (the RenderAssets/contractURI image) first, then one
 * sample render from the collection's renderer, then the plain fallback
 * line. Pure so the selection order is unit-testable without a chain read.
 */
export type PreMintHeroSource = "cover" | "sample" | "fallback"

export function selectPreMintHero(hasCover: boolean, hasSample: boolean): PreMintHeroSource {
  if (hasCover) return "cover"
  if (hasSample) return "sample"
  return "fallback"
}

/**
 * Collection page hero layout: "single" for one visual with title,
 * description and mint info beside it (pre-mint, or a minted collection
 * with no token grid to show), "grid" for the wide banner plus token grid.
 * Pure over the two inputs that decide it, so the split is unit-testable
 * without a chain or indexer read.
 */
export type CollectionHeroMode = "single" | "grid"

export function selectCollectionHeroMode(preMint: boolean, gridTokenCount: number): CollectionHeroMode {
  if (preMint) return "single"
  return gridTokenCount > 0 ? "grid" : "single"
}
