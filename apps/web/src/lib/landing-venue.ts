import "server-only"
import { unstable_cache } from "next/cache"
import type { Address } from "viem"
import { getCollection, getRecentCollections } from "./collection-onchain"
import {
  SurfaceStatus,
  ZERO_ADDRESS,
  formatPriceLabel,
  hasPriceStrategy,
  lifecycleStatus,
  saleWindowOf,
  surfaceFactory,
  type Collection,
} from "./collection"
import { getCollectionArtwork } from "./collection-artwork"
import type { DisplayMedia } from "./display-media"
import { readEnsIdentities } from "./ens-identity-store"
import { featuredReleaseEditorial, getReleaseEditorial } from "./release-editorial"

/**
 * View model for the landing release venue. Everything a card renders is
 * precomputed here and JSON-safe, so the whole model caches as one entry
 * and a request pays one cache read instead of a dozen Postgres and RPC
 * round trips. Status is derived at render from `mintStart` and `minted`
 * so a 60 s old model never shows a stale label.
 */
export type VenueRelease = {
  address: string
  name: string
  artistLabel: string
  /** Unix seconds; 0 when the sale has no start. */
  mintStart: number
  /** Unix seconds; 0 when the sale has no end. */
  mintEnd: number
  /** Decimal string to preserve the full uint256 value in the cached model. */
  minted: string
  /** "0" when uncapped. */
  cap: string
  priceLabel: string
  artwork: DisplayMedia
}

export type VenueModel = {
  featured: VenueRelease & { summary: string | null; programmed: boolean }
  upcoming: VenueRelease[]
  recent: VenueRelease[]
}

const RECENT_LIMIT = 18
const SHELF_LIMIT = 3

export function venueStatus(release: VenueRelease, nowSec: number): SurfaceStatus {
  return lifecycleStatus(
    {
      mintStart: BigInt(release.mintStart),
      mintEnd: BigInt(release.mintEnd),
      supplyCap: BigInt(release.cap),
    },
    BigInt(release.minted),
    nowSec,
  )
}

async function buildVenueModel(): Promise<VenueModel | null> {
  const factory = surfaceFactory()
  if (!factory) return null

  const programmedEditorial = featuredReleaseEditorial()
  const [recent, programmed] = await Promise.all([
    getRecentCollections(factory, RECENT_LIMIT).catch(() => [] as Collection[]),
    Promise.all(
      programmedEditorial.map((entry) =>
        getCollection(entry.collection as Address).catch(() => null),
      ),
    ),
  ])

  const byAddress = new Map<string, Collection>()
  for (const c of [...recent, ...programmed.filter((c): c is Collection => c !== null)]) {
    byAddress.set(c.address.toLowerCase(), c)
  }
  const all = Array.from(byAddress.values())
  if (all.length === 0) return null

  const [identities, artwork] = await Promise.all([
    readEnsIdentities(all.map((c) => c.owner)),
    getCollectionArtwork(all),
  ])

  const toRelease = (c: Collection): VenueRelease => {
    const window = saleWindowOf(c)
    const priceStrategy = c.sale?.priceStrategy ?? ZERO_ADDRESS
    const cap = smallestPositive(c.cfg.supplyCap, c.sale?.maxMints ?? 0n)
    const identity = identities.get(c.owner.toLowerCase())
    return {
      address: c.address,
      name: c.name,
      artistLabel: identity?.ensName ?? `${c.owner.slice(0, 6)}…${c.owner.slice(-4)}`,
      mintStart: Number(window.mintStart),
      mintEnd: Number(window.mintEnd),
      minted: c.minted.toString(),
      cap: cap.toString(),
      priceLabel: hasPriceStrategy(priceStrategy)
        ? "Live price"
        : formatPriceLabel(c.sale?.price ?? 0n),
      artwork: artwork.get(c.address.toLowerCase()) ?? { kind: "none" },
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const recentReleases = recent.map(toRelease)
  const hasArt = (r: VenueRelease) => r.artwork.kind !== "none"
  const statusOf = (r: VenueRelease) => venueStatus(r, now)

  const programmedPick = programmedEditorial
    .map((editorial) => ({
      editorial,
      release: byAddress.get(editorial.collection),
    }))
    .find((candidate) => candidate.release !== undefined)

  const featuredRelease =
    (programmedPick?.release ? toRelease(programmedPick.release) : undefined) ??
    recentReleases.find((r) => statusOf(r) === SurfaceStatus.Open && hasArt(r)) ??
    recentReleases.find((r) => statusOf(r) === SurfaceStatus.Scheduled && hasArt(r)) ??
    recentReleases.find(hasArt) ??
    toRelease(all[0])

  const editorial =
    programmedPick?.editorial ?? getReleaseEditorial(featuredRelease.address)
  const featuredKey = featuredRelease.address.toLowerCase()
  const others = recentReleases.filter((r) => r.address.toLowerCase() !== featuredKey)

  return {
    featured: {
      ...featuredRelease,
      summary: editorial?.editorialSummary ?? null,
      programmed: programmedPick !== undefined,
    },
    upcoming: others.filter((r) => statusOf(r) === SurfaceStatus.Scheduled).slice(0, SHELF_LIMIT),
    // Recent row leads with the featured release, then the most recent
    // non-scheduled releases, so the featured also appears in the list.
    // featuredRelease can be a programmed pick absent from recentReleases,
    // so prepend it rather than relying on it being in `others`.
    recent: [
      featuredRelease,
      ...others.filter((r) => statusOf(r) !== SurfaceStatus.Scheduled),
    ].slice(0, SHELF_LIMIT),
  }
}

/** Cached for 60 s across requests; a failed build is not cached. */
export const getVenueModel = unstable_cache(
  async (): Promise<VenueModel | null> => {
    const model = await buildVenueModel()
    if (model === null) throw new Error("venue unavailable")
    return model
  },
  ["landing-venue-v1"],
  { revalidate: 60, tags: ["landing-venue"] },
)

function smallestPositive(a: bigint, b: bigint): bigint {
  if (a === 0n) return b
  if (b === 0n) return a
  return a < b ? a : b
}
