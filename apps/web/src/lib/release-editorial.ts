import rawEditorial from "@/content/releases.json"

export type ReleaseEditorial = {
  collection: string
  slug: string | null
  featured: boolean
  featureOrder: number | null
  editorialSummary: string | null
}

type RawReleaseEditorial = {
  collection?: unknown
  slug?: unknown
  featured?: unknown
  featureOrder?: unknown
  editorialSummary?: unknown
}

const ADDRESS = /^0x[a-f0-9]{40}$/

function parseEditorial(): ReleaseEditorial[] {
  if (rawEditorial.version !== 1 || !Array.isArray(rawEditorial.releases)) {
    throw new Error("release editorial content must use schema version 1")
  }

  const collections = new Set<string>()
  const featureOrders = new Set<number>()

  return (rawEditorial.releases as RawReleaseEditorial[]).map((entry, index) => {
    if (typeof entry.collection !== "string" || !ADDRESS.test(entry.collection)) {
      throw new Error(`release editorial entry ${index} has an invalid collection`)
    }
    if (collections.has(entry.collection)) {
      throw new Error(`release editorial content repeats ${entry.collection}`)
    }
    collections.add(entry.collection)

    const featured = entry.featured === true
    const featureOrder =
      typeof entry.featureOrder === "number" && Number.isSafeInteger(entry.featureOrder)
        ? entry.featureOrder
        : null
    if (featured && (featureOrder === null || featureOrder < 1)) {
      throw new Error(`featured release ${entry.collection} needs a positive featureOrder`)
    }
    if (!featured && featureOrder !== null) {
      throw new Error(`unfeatured release ${entry.collection} cannot have a featureOrder`)
    }
    if (featureOrder !== null) {
      if (featureOrders.has(featureOrder)) {
        throw new Error(`release editorial content repeats featureOrder ${featureOrder}`)
      }
      featureOrders.add(featureOrder)
    }

    const slug = typeof entry.slug === "string" && entry.slug.trim() ? entry.slug.trim() : null
    const editorialSummary =
      typeof entry.editorialSummary === "string" && entry.editorialSummary.trim()
        ? entry.editorialSummary.trim()
        : null

    return {
      collection: entry.collection,
      slug,
      featured,
      featureOrder,
      editorialSummary,
    }
  })
}

export const releaseEditorial = parseEditorial()

const editorialByCollection = new Map(
  releaseEditorial.map((entry) => [entry.collection, entry] as const),
)

export function getReleaseEditorial(collection: string): ReleaseEditorial | null {
  return editorialByCollection.get(collection.toLowerCase()) ?? null
}

export function featuredReleaseEditorial(): ReleaseEditorial[] {
  return releaseEditorial
    .filter((entry) => entry.featured)
    .sort((a, b) => (a.featureOrder ?? 0) - (b.featureOrder ?? 0))
}
