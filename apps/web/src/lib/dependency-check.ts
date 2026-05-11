import "server-only"
import { unstable_cache } from "next/cache"
import type { Address } from "viem"
import { pgCache } from "./pg-cache"
import { getArtistIdentity } from "./artist-queries"
import {
  IndexerUnavailable,
  getActiveAuctionCountFromIndexer,
  getActiveFndAuctionCount,
  getActiveFndBuyNowCount,
  getFoundationCreatorSummary,
  getFoundationSalesSummary,
} from "./indexer-queries"
import { getSovereignHouseOf } from "./sovereign-house"
import {
  countByPlatform,
  getSellerListingsPayload,
  type SellerListingsPayload,
} from "./seller-listings-server"
import type { PlatformId } from "./platforms/types"

// Human-readable labels for the sale-paths card. Platform IDs come from
// `platforms/types.ts`; keep this map in sync if a new platform lands.
const PLATFORM_LABELS: Record<PlatformId, string> = {
  foundation: "Foundation",
  sovereign: "Sovereign",
  superrareV2: "SuperRare",
  transient: "Transient",
  manifold: "Manifold",
}

/**
 * Assemble the `/api/dependency/[address]` scan report from indexed data.
 *
 * Every check that ships in v1 reads from Ponder Postgres or from an
 * already-cached helper. No live RPC fanout, no per-token tokenURI calls,
 * no token-inventory crawling. When a single check can't be served from
 * the indexer (DB down, timeout, kill switch), it degrades to
 * `UnableToCheck` for that card only — the rest of the report still
 * renders.
 *
 * The dependency-map cards (metadata host, royalty recipient, etc.) are
 * static `NotCheckedYet` entries with honest one-line reasons. Adding a
 * previously-deferred check later means extending Ponder, not making
 * this orchestrator heavier.
 */

export type CheckStatus =
  | "Detected"
  | "NeedsReview"
  | "NotFound"
  | "UnableToCheck"
  | "NotCheckedYet"

export type CheckAction = {
  label: string
  href: string
}

export type CheckedCard = {
  id: string
  title: string
  status: CheckStatus
  source: string
  detail: Record<string, unknown>
  actions: CheckAction[]
}

export type DependencyCard = {
  id: string
  title: string
  status: "NotCheckedYet"
  reason: string
}

export type SerializedIdentity = {
  address: string
  ensName: string | null
  displayName: string
  avatarUrl: string | null
}

export type DependencyReport = {
  identity: SerializedIdentity
  summary: {
    run: number
    detected: number
    review: number
    notFound: number
    notChecked: number
  }
  checkedCards: CheckedCard[]
  dependencyCards: DependencyCard[]
  generatedAt: number
  indexerHealthy: boolean
}

// Static dependency-map list. Each entry explains what would be required
// to verify it, so the page can render "Not checked yet" honestly without
// implying PND scanned everything.
const DEPENDENCY_MAP: DependencyCard[] = [
  {
    id: "metadata-host",
    title: "Metadata host",
    status: "NotCheckedYet",
    reason:
      "Requires per-token tokenURI fetches; deferred to keep RPC bounded.",
  },
  {
    id: "media-host",
    title: "Media host",
    status: "NotCheckedYet",
    reason: "Requires metadata JSON parsing per token.",
  },
  {
    id: "renderer",
    title: "Renderer dependency",
    status: "NotCheckedYet",
    reason: "No standard renderer registry yet.",
  },
  {
    id: "contract-owner",
    title: "Contract ownership and permissions",
    status: "NotCheckedYet",
    reason:
      "Would require per-contract owner() reads across every collection.",
  },
  {
    id: "upgradeability",
    title: "Upgradeability",
    status: "NotCheckedYet",
    reason: "Per-contract EIP-1967 proxy slot reads not yet wired up.",
  },
  {
    id: "royalty",
    title: "Royalty recipient",
    status: "NotCheckedYet",
    reason: "Per-token royaltyInfo() reads; inconsistent across contracts.",
  },
  {
    id: "collectors",
    title: "Collector base",
    status: "NotCheckedYet",
    reason: "Transfer log scan not indexed yet.",
  },
  {
    id: "frontend",
    title: "Frontend dependency",
    status: "NotCheckedYet",
    reason: "Off-chain probe; outside the on-chain scope of this scan.",
  },
]

// Tiny helper: indexer reads return null on unavailability. We want the
// orchestrator to distinguish "indexer said the count is 0" from
// "indexer couldn't answer." This wrapper preserves both states.
type IndexerResult<T> = { ok: true; value: T } | { ok: false }

async function tryIndexer<T>(
  fn: () => Promise<T | null>,
): Promise<IndexerResult<T>> {
  try {
    const value = await fn()
    if (value === null) return { ok: false }
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}

// Hard cap on the seller-listings fan-out so a slow non-PND adapter
// (SuperRare V2 / Transient `eth_getLogs` over millions of blocks on
// cold cache) can't gate the rest of the report. Indexer-backed cards
// complete in <500ms each; this is the only call that can stretch.
//
// Tradeoff: if this fires, the report is cached as UnableToCheck for
// the listings card for the full TTL (5 min). Acceptable because (a)
// indexer-backed cards are still real, (b) the seller-listings cache
// keeps warming in the background, and (c) the next scan after 5 min
// gets the fresh answer. Worse alternative: blocking the page for 30s.
const LISTINGS_TIMEOUT_MS = 5_000

async function listingsWithTimeout(
  addr: string,
): Promise<
  | { ok: true; value: SellerListingsPayload }
  | { ok: false }
> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const listingsP = getSellerListingsPayload(addr)
    .then((value) => ({ ok: true as const, value }))
    .catch(() => ({ ok: false as const }))
  const timeoutP = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `dependency-check: seller-listings timed out after ${LISTINGS_TIMEOUT_MS}ms for ${addr}`,
      )
      resolve({ ok: false as const })
    }, LISTINGS_TIMEOUT_MS)
  })
  try {
    return await Promise.race([listingsP, timeoutP])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function unableToCheck(
  id: string,
  title: string,
  source: string,
): CheckedCard {
  return {
    id,
    title,
    status: "UnableToCheck",
    source,
    detail: { reason: "indexer-unavailable" },
    actions: [],
  }
}

export async function buildDependencyReport(
  address: Address,
): Promise<DependencyReport> {
  const addrLower = address.toLowerCase()

  const [
    identity,
    fndCreator,
    activeFnd,
    activeFndBuyNows,
    house,
    activePnd,
    fndSales,
    listings,
  ] = await Promise.all([
    getArtistIdentity(address),
    tryIndexer(() => getFoundationCreatorSummary(addrLower)),
    tryIndexer(() => getActiveFndAuctionCount(addrLower)),
    tryIndexer(() => getActiveFndBuyNowCount(addrLower)),
    // `getSovereignHouseOf` never throws and falls back to an on-chain
    // `houseOf` call only when Postgres is unreachable (see header
    // comment in sovereign-house.ts).
    getSovereignHouseOf(address).catch(() => null),
    tryIndexer(() => getActiveAuctionCountFromIndexer(addrLower)),
    tryIndexer(() => getFoundationSalesSummary(addrLower)),
    // Seller-listings is the only fan-out that touches non-PND platforms.
    // Hard timeout so a slow `eth_getLogs` adapter doesn't gate the
    // rest of the report; see `listingsWithTimeout`.
    listingsWithTimeout(addrLower),
  ])

  const cards: CheckedCard[] = []

  // 1. Foundation exposure
  if (fndCreator.ok) {
    const { tokenCount, collectionCount } = fndCreator.value
    const detected = tokenCount > 0 || collectionCount > 0
    cards.push({
      id: "foundation-exposure",
      title: "Foundation exposure",
      status: detected ? "Detected" : "NotFound",
      source: "ponder:fnd_artist_tokens + fnd_collections",
      detail: { tokenCount, collectionCount },
      actions: detected
        ? [{ label: "Open artist page", href: `/artist/${addrLower}` }]
        : [],
    })
  } else {
    cards.push(
      unableToCheck(
        "foundation-exposure",
        "Foundation exposure",
        "ponder:fnd_artist_tokens + fnd_collections",
      ),
    )
  }

  // 2. Active Foundation listings (auctions + buy-nows)
  if (activeFnd.ok && activeFndBuyNows.ok) {
    const auctions = activeFnd.value
    const buyNows = activeFndBuyNows.value
    const total = auctions + buyNows
    cards.push({
      id: "active-fnd-listings",
      title: "Active Foundation listings",
      status: total > 0 ? "Detected" : "NotFound",
      source: "ponder:fnd_auctions + fnd_buy_nows",
      detail: { auctions, buyNows, total },
      actions:
        total > 0
          ? [{ label: "Open artist page", href: `/artist/${addrLower}` }]
          : [],
    })
  } else {
    cards.push(
      unableToCheck(
        "active-fnd-listings",
        "Active Foundation listings",
        "ponder:fnd_auctions + fnd_buy_nows",
      ),
    )
  }

  // 3. Sovereign Auction House owned by artist
  cards.push({
    id: "sovereign-house",
    title: "Sovereign Auction House",
    status: house ? "Detected" : "NotFound",
    source: "ponder:pnd_houses",
    detail: { house: house ?? null },
    actions: house
      ? [{ label: "Open artist page", href: `/artist/${addrLower}` }]
      : [],
  })

  // 4. Active Sovereign auctions
  if (activePnd.ok) {
    const count = activePnd.value
    cards.push({
      id: "active-pnd-auctions",
      title: "Active Sovereign auctions",
      status: count > 0 ? "Detected" : "NotFound",
      source: "ponder:pnd_auctions",
      detail: { count },
      actions:
        count > 0
          ? [{ label: "Open artist page", href: `/artist/${addrLower}` }]
          : [],
    })
  } else {
    cards.push(
      unableToCheck(
        "active-pnd-auctions",
        "Active Sovereign auctions",
        "ponder:pnd_auctions",
      ),
    )
  }

  // 5. Delistable / unsettled items
  if (listings.ok) {
    const { auctions, buyNows } = listings.value
    const byPlatform = countByPlatform(listings.value)
    const total = auctions.length + buyNows.length
    cards.push({
      id: "delistable",
      title: "Delistable / unsettled items",
      status: total > 0 ? "Detected" : "NotFound",
      source: "api:seller-listings",
      detail: { auctions: auctions.length, buyNows: buyNows.length, byPlatform },
      actions:
        total > 0
          ? [{ label: "Open artist page", href: `/artist/${addrLower}` }]
          : [],
    })
  } else {
    cards.push(
      unableToCheck(
        "delistable",
        "Delistable / unsettled items",
        "api:seller-listings",
      ),
    )
  }

  // 6. Sale paths observed — union of platforms with active listings and
  // any platform we have settled sales for (Foundation only, today).
  const marketplaces = new Set<PlatformId>()
  if (listings.ok) {
    for (const a of listings.value.auctions) marketplaces.add(a.platform)
    for (const b of listings.value.buyNows) marketplaces.add(b.platform)
  }
  if (fndSales.ok && fndSales.value.hasFoundation) {
    marketplaces.add("foundation")
  }
  // Sovereign sales aren't in fnd_sales but they're proven by an artist's
  // house existence — surface that as a Sovereign sale path too.
  if (house) marketplaces.add("sovereign")
  const marketplaceList = [...marketplaces]
  const sale6CanAnswer =
    listings.ok || fndSales.ok || house !== undefined
  if (sale6CanAnswer) {
    cards.push({
      id: "sale-paths",
      title: "Sale paths observed",
      status: marketplaceList.length > 0 ? "Detected" : "NotFound",
      source: "ponder:fnd_sales + api:seller-listings",
      detail: {
        marketplaces: marketplaceList,
        marketplaceLabels: marketplaceList.map((id) => PLATFORM_LABELS[id]),
        foundationSalesCount: fndSales.ok ? fndSales.value.saleCount : null,
      },
      actions: [],
    })
  } else {
    cards.push(
      unableToCheck(
        "sale-paths",
        "Sale paths observed",
        "ponder:fnd_sales + api:seller-listings",
      ),
    )
  }

  // 7. PND artist page presence (derived from #1/#3/#4)
  const hasArtistPage =
    (fndCreator.ok &&
      (fndCreator.value.tokenCount > 0 ||
        fndCreator.value.collectionCount > 0)) ||
    !!house ||
    (activePnd.ok && activePnd.value > 0)
  cards.push({
    id: "pnd-page-presence",
    title: "PND artist page presence",
    status: hasArtistPage ? "Detected" : "NotFound",
    source: "derived",
    detail: { hasArtistPage },
    actions: hasArtistPage
      ? [{ label: "Open artist page", href: `/artist/${addrLower}` }]
      : [],
  })

  // Summary counts.
  let detected = 0
  let review = 0
  let notFound = 0
  let unable = 0
  for (const c of cards) {
    if (c.status === "Detected") detected++
    else if (c.status === "NeedsReview") review++
    else if (c.status === "NotFound") notFound++
    else if (c.status === "UnableToCheck") unable++
  }

  return {
    identity: {
      address: identity.address,
      ensName: identity.ensName,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
    },
    summary: {
      run: cards.length,
      detected,
      review,
      notFound,
      notChecked: DEPENDENCY_MAP.length,
    },
    checkedCards: cards,
    dependencyCards: DEPENDENCY_MAP,
    generatedAt: Math.floor(Date.now() / 1000),
    indexerHealthy: unable === 0,
  }
}

// Re-export so route handlers can `catch` it explicitly. Not used by the
// orchestrator itself — `tryIndexer` swallows it inline — but exposing
// the type makes the contract clear.
export { IndexerUnavailable }

export const DEPENDENCY_SCAN_TTL_S = 5 * 60

/**
 * Cached scan-report builder. Same two-layer cache pattern the rest of
 * the codebase uses: `unstable_cache` per Node sandbox over `pgCache`
 * keyed by lowercased address. Both the API route and the server-side
 * result page consume this single function so they share one cache.
 */
export const getDependencyReport = unstable_cache(
  (addressLower: string) =>
    pgCache<DependencyReport>(
      `artist-dependency:${addressLower}`,
      DEPENDENCY_SCAN_TTL_S,
      () => buildDependencyReport(addressLower as Address),
    ),
  ["artist-dependency-v2"],
  { revalidate: DEPENDENCY_SCAN_TTL_S, tags: ["artist-dependency"] },
)
