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
