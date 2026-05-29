import "server-only"
import { unstable_cache } from "next/cache"
import type { Address } from "viem"
import { sql } from "./db"
import { getArtistIdentity, getEnsUrl } from "./artist-queries"
import {
  IndexerUnavailable,
  getArtistContractMap,
  getFoundationSalesSummary,
} from "./indexer-queries"
import { getSovereignHouseOf } from "./sovereign-house"
import {
  getSellerListingsPayload,
  type SellerListingsPayload,
} from "./seller-listings-server"
import {
  classifyContract,
  declaredOnlyEntry,
  type ContractMapEntry,
  type ContractRow,
} from "./contract-classifier"
import {
  getArtistInventory,
  type ArtistInventory,
  type PlatformError,
} from "./artist-inventory"
import { getCatalog, type Catalog } from "./catalog"
import type { PlatformId } from "./platforms/types"
import { classifyUrl, extractBareCid, type HostBucket } from "./metadata-host"

/**
 * Assemble the Artist Dependency Report.
 *
 * Goal: help artists understand the systems around their work — what
 * lives where, which parts appear artist-controlled, and which areas
 * still need a closer look. Not a contract audit, not a manifesto.
 *
 * Data path: Ponder Postgres for Foundation/PND, lazy-cached platform
 * adapters for Manifold/SuperRare/Transient (each with its own 30-day
 * cache and a 4s per-platform timeout in `artist-inventory.ts`). Zero
 * live RPC in steady state; cold-cache scans pay the platform adapter
 * cost once.
 */

const LISTINGS_TIMEOUT_MS = 5_000

export type CheckStatus =
  | "Detected"
  | "NotFound"
  | "Checked"
  | "NotYet"
  | "Unable"

export type SerializedIdentity = {
  address: string
  ensName: string | null
  displayName: string
  avatarUrl: string | null
}

export type InventoryTotals = {
  totalTokens: number
  totalContracts: number
  artistOwnedContracts: number
  platformContracts: number
  sharedContracts: number
  unknownContracts: number
}

export type DependencyReadLabel = "Lower" | "Moderate" | "Higher" | "Unknown"

export type DependencyRead = {
  label: DependencyReadLabel
  summary: string
}

export type AreaEntry = {
  id: string
  title: string
  status: CheckStatus
  canCheckNow: boolean
  summary: string
  whatWouldHelp?: string
}

export type NextStep = {
  id: string
  title: string
  href: string
  reason: string
}

export type PlatformCoverage = {
  covered: PlatformId[]
  errors: PlatformError[]
}

export type DisplayPathSummary = {
  totalIndexed: number
  totalWithMetadata: number
  metadataByBucket: Record<HostBucket, number>
  mediaByBucket: Record<HostBucket, number>
  topCentralizedHosts: Array<{ host: string; count: number }>
}

/**
 * Per-bucket preservation signal. Populated by the worker's
 * `probe-cid-availability` task (writes `cid_availability`) and, in
 * Phase 2b, by the `/preserve` writeback (writes `token_pins`).
 *
 *   ipfs.totalCids        — distinct CIDs referenced by this artist
 *                           (across metadata + media URLs)
 *   ipfs.retrievableCount — CIDs whose latest probe came back ok
 *   ipfs.unretrievableCount — CIDs whose latest probe failed every gateway
 *   ipfs.unprobedCount    — CIDs not yet in cid_availability (the
 *                           worker hasn't reached them yet)
 *   ipfs.artistPinnedCount — CIDs the artist self-declared as pinned
 *                           (Phase 2b; always 0 here)
 *
 *   arweave / onchain     — analogous; arweave gets a probe loop
 *                           parallel to ipfs (deferred; counters
 *                           reported as unprobed in 2a-only mode);
 *                           onchain is trivially preserved.
 *
 *   centralized.totalCount — count of URLs (not CIDs) — centralized
 *                            hosts don't have a content-address key
 *                            so they're counted per-URL.
 *   centralized.reachableCount — populated by a future HEAD probe;
 *                                always 0 in this initial 2a (the
 *                                URL-liveness probe is deliberately
 *                                deferred).
 *   centralized.topHosts  — top 5 hosts by URL count.
 */
export type PreservationSummary = {
  ipfs: {
    totalCids: number
    retrievableCount: number
    unretrievableCount: number
    unprobedCount: number
    artistPinnedCount: number
  }
  arweave: {
    totalCids: number
    retrievableCount: number
    unprobedCount: number
  }
  onchain: { totalCount: number }
  centralized: {
    totalCount: number
    reachableCount: number
    topHosts: Array<{ host: string; count: number }>
  }
}

export type DependencyReport = {
  identity: SerializedIdentity
  inventoryTotals: InventoryTotals
  contractMap: ContractMapEntry[]
  dependencyRead: DependencyRead
  areasToReview: AreaEntry[]
  recommendedNextSteps: NextStep[]
  platformCoverage: PlatformCoverage
  displayPath: DisplayPathSummary
  preservation: PreservationSummary
  generatedAt: number
  indexerHealthy: boolean
}

// ── helpers ──────────────────────────────────────────────────────────────

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

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

const TOP_CENTRALIZED_HOSTS = 5

function emptyBucketCounts(): Record<HostBucket, number> {
  return { ipfs: 0, arweave: 0, onchain: 0, centralized: 0, unresolved: 0 }
}

function emptyDisplayPathSummary(): DisplayPathSummary {
  return {
    totalIndexed: 0,
    totalWithMetadata: 0,
    metadataByBucket: emptyBucketCounts(),
    mediaByBucket: emptyBucketCounts(),
    topCentralizedHosts: [],
  }
}

type ArtistTokenMetadataRow = {
  raw_uri: string | null
  image_url: string | null
  animation_url: string | null
  has_metadata: boolean
}

/**
 * Shared row source for the Display path + Preservation summaries.
 *
 * UNION over the same three tables `reads.ts:getArtistTokens` uses —
 * worker `artist_tokens` + Ponder `fnd_artist_tokens` + Ponder
 * `srv2_artist_tokens` — LEFT JOIN to `token_metadata`. Returns one
 * row per (contract, token_id), so callers can derive their own
 * counts without re-running the UNION.
 *
 * `has_metadata` here is ROW-PRESENCE (`m.contract IS NOT NULL`), so
 * downstream code can distinguish "indexed but not warmed yet" from
 * "warmed but payload all-null." The preservation summary applies an
 * additional payload-presence filter on top.
 *
 * Catches schema-not-ready (fresh deploy) and returns an empty list so
 * the report renders gracefully.
 */
async function getArtistTokenMetadataRows(
  addrLower: string,
): Promise<ArtistTokenMetadataRow[]> {
  if (!sql) return []
  try {
    return (await sql.unsafe(
      `WITH refs AS (
         SELECT lower(contract) AS contract, token_id
         FROM artist_tokens WHERE artist = $1
         UNION
         SELECT lower(contract), token_id::text
         FROM ${INDEXER_SCHEMA}.fnd_artist_tokens WHERE lower(creator) = $1
         UNION
         SELECT lower(contract), token_id::text
         FROM ${INDEXER_SCHEMA}.srv2_artist_tokens WHERE lower(creator) = $1
       )
       SELECT m.raw_uri, m.image_url, m.animation_url,
              (m.contract IS NOT NULL) AS has_metadata
       FROM refs r
       LEFT JOIN token_metadata m
         ON m.contract = r.contract AND m.token_id = r.token_id`,
      [addrLower],
    )) as ArtistTokenMetadataRow[]
  } catch {
    return []
  }
}

/**
 * Display-path summary: classify every indexed token's metadata URL
 * and media URL into a HostBucket, count by bucket, and surface the
 * top centralized hosts. Pure SQL — the worker has already pre-resolved
 * `token_metadata` for every token whose creator is in known_artists.
 *
 * Source rows from `getArtistTokenMetadataRows` so the UNION-query
 * shape stays in one place; the Preservation summary uses the same
 * rows.
 */
async function getDisplayPathSummary(
  addrLower: string,
): Promise<DisplayPathSummary> {
  const rows = await getArtistTokenMetadataRows(addrLower)
  const summary = emptyDisplayPathSummary()
  summary.totalIndexed = rows.length

  const centralizedHostCounts = new Map<string, number>()

  for (const r of rows) {
    if (r.has_metadata) summary.totalWithMetadata++

    const metaClass = classifyUrl(r.raw_uri)
    summary.metadataByBucket[metaClass.bucket]++
    if (metaClass.bucket === "centralized" && metaClass.host) {
      centralizedHostCounts.set(
        metaClass.host,
        (centralizedHostCounts.get(metaClass.host) ?? 0) + 1,
      )
    }

    const mediaClass = classifyUrl(r.image_url ?? r.animation_url)
    summary.mediaByBucket[mediaClass.bucket]++
    if (mediaClass.bucket === "centralized" && mediaClass.host) {
      centralizedHostCounts.set(
        mediaClass.host,
        (centralizedHostCounts.get(mediaClass.host) ?? 0) + 1,
      )
    }
  }

  summary.topCentralizedHosts = [...centralizedHostCounts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CENTRALIZED_HOSTS)

  return summary
}

function emptyPreservationSummary(): PreservationSummary {
  return {
    ipfs: {
      totalCids: 0,
      retrievableCount: 0,
      unretrievableCount: 0,
      unprobedCount: 0,
      artistPinnedCount: 0,
    },
    arweave: { totalCids: 0, retrievableCount: 0, unprobedCount: 0 },
    onchain: { totalCount: 0 },
    centralized: { totalCount: 0, reachableCount: 0, topHosts: [] },
  }
}

/**
 * Preservation summary — composite per-bucket signal.
 *
 *   IPFS:        gateway-retrievable from `cid_availability` (probed
 *                by `apps/worker/src/tasks/probe-cid-availability.ts`).
 *   Arweave:     same `cid_availability` table conceptually, but the
 *                worker doesn't probe Arweave gateways yet — so every
 *                Arweave CID is counted as `unprobed` until that ships.
 *   Onchain:     trivially preserved — data lives on-chain.
 *   Centralized: counts URLs (not CIDs — there's no content-address
 *                key) and surfaces the top hosts. `reachableCount` is
 *                always 0 in this initial Phase 2a; URL-liveness probe
 *                is deferred per the planning doc.
 *
 * Distinct-CID semantics: the same IPFS CID can be referenced by both
 * a metadata URL and a media URL on the same row, or across rows for
 * the same artist (a manifold-style "all tokens point at one cover
 * image"). We de-duplicate by CID before counting so the totals match
 * the cache table's PK shape.
 *
 * Payload-presence filter (matches the planned Phase 1 review fix):
 * skip rows whose raw_uri / image_url / animation_url are all null —
 * a warmed row with no payload contributes nothing to preservation.
 */
async function getPreservationSummary(
  addrLower: string,
): Promise<PreservationSummary> {
  if (!sql) return emptyPreservationSummary()

  const rows = await getArtistTokenMetadataRows(addrLower)
  const summary = emptyPreservationSummary()

  // Per-bucket sets. CIDs (ipfs/arweave) dedupe via Set; centralized
  // host counts are weighted by occurrence.
  const ipfsCids = new Set<string>()
  const arweaveCids = new Set<string>()
  let onchainCount = 0
  let centralizedCount = 0
  const centralizedHostCounts = new Map<string, number>()

  for (const r of rows) {
    // Payload-presence: an all-null row contributes nothing.
    if (!r.raw_uri && !r.image_url && !r.animation_url) continue

    const urls = [r.raw_uri, r.image_url ?? r.animation_url]
    for (const url of urls) {
      const classification = classifyUrl(url)
      switch (classification.bucket) {
        case "ipfs": {
          const cid = extractBareCid(url)
          if (cid) ipfsCids.add(cid)
          break
        }
        case "arweave": {
          // Arweave content addresses use the tx id; reusing
          // extractBareCid wouldn't help (different shape). For 2a we
          // count Arweave URLs themselves as the dedup key. A future
          // Arweave-CID extractor can replace this.
          if (url) arweaveCids.add(url.trim())
          break
        }
        case "onchain":
          onchainCount++
          break
        case "centralized":
          centralizedCount++
          if (classification.host) {
            centralizedHostCounts.set(
              classification.host,
              (centralizedHostCounts.get(classification.host) ?? 0) + 1,
            )
          }
          break
        case "unresolved":
          break
      }
    }
  }

  summary.ipfs.totalCids = ipfsCids.size
  summary.arweave.totalCids = arweaveCids.size
  summary.onchain.totalCount = onchainCount
  summary.centralized.totalCount = centralizedCount
  summary.centralized.topHosts = [...centralizedHostCounts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CENTRALIZED_HOSTS)

  // Join the IPFS CIDs against cid_availability in a single query.
  // `unprobed` = no row in the cache yet (worker hasn't reached it);
  // `retrievable` / `unretrievableCount` follow the boolean column.
  if (ipfsCids.size > 0) {
    try {
      const rows = (await sql<
        Array<{ retrievable: boolean; count: number }>
      >`
        SELECT retrievable, COUNT(*)::int AS count
          FROM cid_availability
         WHERE cid = ANY(${Array.from(ipfsCids)}::text[])
         GROUP BY retrievable
      `) as Array<{ retrievable: boolean; count: number }>
      let probed = 0
      for (const r of rows) {
        if (r.retrievable) summary.ipfs.retrievableCount = r.count
        else summary.ipfs.unretrievableCount = r.count
        probed += r.count
      }
      summary.ipfs.unprobedCount = Math.max(0, ipfsCids.size - probed)
    } catch {
      // Table missing (migration not yet applied) or transient DB blip
      // — treat everything as unprobed. The area then renders as
      // `Unable` rather than crashing the whole report.
      summary.ipfs.unprobedCount = ipfsCids.size
    }
  }

  // Arweave gateway probe is deferred in 2a — treat every Arweave CID
  // as unprobed. The shape is here so the renderer doesn't change
  // when 2a-Arweave lands.
  summary.arweave.unprobedCount = arweaveCids.size

  return summary
}

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

// ── classification ───────────────────────────────────────────────────────

/**
 * Combine indexer rows (Foundation), platform-adapter rows (non-Foundation),
 * the artist's Sovereign house, and on-chain registry declarations into a
 * single classified contract map. Registry declarations are dual-purposed:
 * they bump the `declaredInRegistry` flag on auto-detected entries AND
 * surface declared-only contracts as new rows.
 */
function buildContractMap(args: {
  artistAddress: string
  fndRows: ContractRow[] | null
  inventory: ArtistInventory
  sovereignHouse: string | null
  declaredContracts: ReadonlySet<string>
}): ContractMapEntry[] {
  const { artistAddress, fndRows, inventory, sovereignHouse, declaredContracts } = args
  const seen = new Set<string>()
  const entries: ContractMapEntry[] = []

  // Foundation rows first (richer metadata via fnd_collections).
  if (fndRows) {
    for (const r of fndRows) {
      const entry = classifyContract(r, artistAddress, declaredContracts)
      entries.push(entry)
      seen.add(entry.contract)
    }
  }

  // Other platforms — skip anything already accounted for by Ponder.
  for (const c of inventory.contracts) {
    if (seen.has(c.contract)) continue
    entries.push(
      classifyContract(
        {
          contract: c.contract,
          tokenCount: c.tokenCount,
          collectionName: c.collectionName,
          platform: c.platform,
        },
        artistAddress,
        declaredContracts,
      ),
    )
    seen.add(c.contract)
  }

  // Sovereign auction house, if any. Token count = 0 (it's an auction
  // contract, not a token contract) but we surface it as artist-owned
  // capability per product direction.
  if (sovereignHouse && !seen.has(sovereignHouse.toLowerCase())) {
    entries.push(
      classifyContract(
        {
          contract: sovereignHouse,
          tokenCount: 0,
          isSovereignHouse: true,
        },
        artistAddress,
        declaredContracts,
      ),
    )
    seen.add(sovereignHouse.toLowerCase())
  }

  // Declared-but-undetected contracts. These are claimed by the artist
  // on-chain but no platform adapter discovered them — either because
  // the contract isn't on a supported platform or the artist deployed
  // something we don't know how to classify. Surface as artist-owned
  // with the registry-declaration flag set.
  for (const declared of declaredContracts) {
    if (seen.has(declared)) continue
    entries.push(declaredOnlyEntry(declared))
    seen.add(declared)
  }

  // Sort: artist-owned first, then by token count desc, then unknown last.
  const TYPE_RANK: Record<string, number> = {
    "artist-owned": 0,
    "pnd-auction": 1,
    "shared-creator": 2,
    platform: 3,
    unknown: 4,
  }
  entries.sort((a, b) => {
    const r = (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9)
    if (r !== 0) return r
    return b.tokenCount - a.tokenCount
  })

  return entries
}

function computeInventoryTotals(map: ContractMapEntry[]): InventoryTotals {
  let totalTokens = 0
  let artistOwned = 0
  let platform = 0
  let shared = 0
  let unknown = 0
  for (const e of map) {
    totalTokens += e.tokenCount
    if (e.type === "artist-owned" || e.type === "pnd-auction") artistOwned++
    else if (e.type === "platform") platform++
    else if (e.type === "shared-creator") shared++
    else unknown++
  }
  return {
    totalTokens,
    totalContracts: map.length,
    artistOwnedContracts: artistOwned,
    platformContracts: platform,
    sharedContracts: shared,
    unknownContracts: unknown,
  }
}

function computeDependencyRead(
  map: ContractMapEntry[],
  totals: InventoryTotals,
): DependencyRead {
  // Token-weighted, not contract-weighted: a single artist-owned
  // contract with 100 tokens beats five shared-contract entries with
  // 1 token each.
  if (totals.totalTokens === 0) {
    const hasHouse = map.some((e) => e.type === "pnd-auction")
    if (hasHouse) {
      return {
        label: "Unknown",
        summary:
          "No tokens detected yet. PND found an artist-owned auction contract for this wallet.",
      }
    }
    return {
      label: "Unknown",
      summary:
        "PND did not find tokens connected to this wallet in supported sources.",
    }
  }

  let artistOwnedTokens = 0
  for (const e of map) {
    if (e.type === "artist-owned") artistOwnedTokens += e.tokenCount
  }
  const ratio = artistOwnedTokens / totals.totalTokens

  if (ratio >= 0.7) {
    return {
      label: "Lower",
      summary:
        "Most detected works sit on artist-owned contracts. Outside systems still apply to media, metadata, and sale paths — a closer look there is recommended.",
    }
  }
  if (ratio >= 0.3) {
    return {
      label: "Moderate",
      summary:
        "Work is spread across artist-owned and shared or platform contracts. Reviewing where the media, metadata, and sale paths live can clarify which parts depend on outside systems.",
    }
  }
  return {
    label: "Higher",
    summary:
      "Most detected works sit on shared or platform contracts. That does not mean the work is broken — it means the artist may want to review where the media, metadata, sale paths, and public context live.",
  }
}

// ── areas to review ──────────────────────────────────────────────────────

type AreaInputs = {
  totals: InventoryTotals
  map: ContractMapEntry[]
  sovereignHouse: string | null
  foundationSalesCount: number | null
  listings: { ok: true; value: SellerListingsPayload } | { ok: false }
  ensUrl: string | null
  platformErrors: PlatformError[]
  displayPath: DisplayPathSummary
  preservation: PreservationSummary
}

function formatPreservationSummary(pres: PreservationSummary): string {
  const parts: string[] = []
  if (pres.ipfs.totalCids > 0) {
    const ipfsParts: string[] = []
    ipfsParts.push(`${pres.ipfs.retrievableCount}/${pres.ipfs.totalCids} retrievable`)
    if (pres.ipfs.unretrievableCount > 0) {
      ipfsParts.push(`${pres.ipfs.unretrievableCount} failing`)
    }
    if (pres.ipfs.unprobedCount > 0) {
      ipfsParts.push(`${pres.ipfs.unprobedCount} not yet probed`)
    }
    if (pres.ipfs.artistPinnedCount > 0) {
      ipfsParts.push(`${pres.ipfs.artistPinnedCount} artist-pinned`)
    }
    parts.push(`IPFS: ${ipfsParts.join(", ")}`)
  }
  if (pres.arweave.totalCids > 0) {
    const arParts: string[] = [`${pres.arweave.totalCids} CIDs`]
    if (pres.arweave.retrievableCount > 0) {
      arParts.push(`${pres.arweave.retrievableCount} retrievable`)
    } else if (pres.arweave.unprobedCount > 0) {
      arParts.push("not yet probed")
    }
    parts.push(`Arweave: ${arParts.join(", ")}`)
  }
  if (pres.onchain.totalCount > 0) {
    parts.push(`On-chain: ${pres.onchain.totalCount}`)
  }
  if (pres.centralized.totalCount > 0) {
    const topHost = pres.centralized.topHosts[0]
    parts.push(
      `Centralized: ${pres.centralized.totalCount}` +
        (topHost ? ` (top: ${topHost.host})` : ""),
    )
  }
  return parts.length > 0
    ? parts.join(". ") + "."
    : "PND found no media or metadata URLs to evaluate."
}

function formatBucketCounts(counts: Record<HostBucket, number>): string {
  // Order matters for the rendered summary: IPFS first (the artist-
  // facing "good" bucket), then arweave, on-chain, centralized,
  // unresolved. Skip zero buckets to keep the line tight.
  const parts: string[] = []
  const order: Array<[HostBucket, string]> = [
    ["ipfs", "IPFS"],
    ["arweave", "Arweave"],
    ["onchain", "on-chain"],
    ["centralized", "centralized"],
    ["unresolved", "unresolved"],
  ]
  for (const [bucket, label] of order) {
    const n = counts[bucket]
    if (n > 0) parts.push(`${n} ${label}`)
  }
  return parts.join(", ")
}

function buildAreasToReview(inputs: AreaInputs): AreaEntry[] {
  const areas: AreaEntry[] = []

  // 1. Contract footprint — always checkable from the contract map.
  const systems = new Set<string>()
  for (const e of inputs.map) if (e.system) systems.add(e.system)
  areas.push({
    id: "contract-footprint",
    title: "Contract footprint",
    status: inputs.totals.totalContracts > 0 ? "Checked" : "NotFound",
    canCheckNow: true,
    summary:
      inputs.totals.totalContracts > 0
        ? `PND identified ${inputs.totals.totalContracts} ${
            inputs.totals.totalContracts === 1 ? "contract" : "contracts"
          } holding work, across ${
            systems.size > 0 ? [...systems].join(", ") : "supported sources"
          }.`
        : "PND did not identify any contracts connected to this wallet.",
  })

  // 2. Display path — classify where every indexed token's metadata
  //    and media live. Pure SQL over the worker-warmed
  //    `token_metadata` table; no RPC.
  const dp = inputs.displayPath
  if (dp.totalIndexed === 0) {
    areas.push({
      id: "display-path",
      title: "Display path",
      status: "NotYet",
      canCheckNow: false,
      summary: "PND hasn't indexed tokens for this wallet.",
      whatWouldHelp:
        "Per-token tokenURI reads plus metadata host classification (planned).",
    })
  } else if (dp.totalWithMetadata === 0) {
    areas.push({
      id: "display-path",
      title: "Display path",
      status: "Unable",
      canCheckNow: false,
      summary:
        "PND has indexed tokens but metadata hasn't resolved yet.",
    })
  } else {
    const metaLine = formatBucketCounts(dp.metadataByBucket)
    const mediaLine = formatBucketCounts(dp.mediaByBucket)
    const topHost = dp.topCentralizedHosts[0]
    const topHostNote =
      dp.metadataByBucket.centralized + dp.mediaByBucket.centralized > 0 &&
      topHost
        ? ` (top: ${topHost.host})`
        : ""
    areas.push({
      id: "display-path",
      title: "Display path",
      status: "Checked",
      canCheckNow: true,
      summary:
        `Metadata: ${metaLine}${topHostNote}. Media: ${mediaLine}.`,
    })
  }

  // 3. Sale path — derived from sales history, active listings, and the
  //    artist's Sovereign house presence.
  const salePathSystems = new Set<string>()
  if ((inputs.foundationSalesCount ?? 0) > 0) salePathSystems.add("Foundation")
  if (inputs.sovereignHouse) salePathSystems.add("PND")
  if (inputs.listings.ok) {
    for (const a of inputs.listings.value.auctions) {
      salePathSystems.add(systemLabelForPlatform(a.platform))
    }
    for (const b of inputs.listings.value.buyNows) {
      salePathSystems.add(systemLabelForPlatform(b.platform))
    }
  }
  areas.push({
    id: "sale-path",
    title: "Sale path",
    status: salePathSystems.size > 0 ? "Checked" : "NotFound",
    canCheckNow: true,
    summary:
      salePathSystems.size > 0
        ? `PND identified sale paths via: ${[...salePathSystems].join(", ")}.`
        : "PND did not identify any sale paths connected to this wallet.",
  })

  // 4. Preservation — composite per-bucket signal sourced from
  //    `cid_availability` (worker probe) + later `token_pins`
  //    (writeback). See `getPreservationSummary` for the layering.
  const pres = inputs.preservation
  if (inputs.displayPath.totalIndexed === 0) {
    areas.push({
      id: "preservation",
      title: "Preservation",
      status: "NotYet",
      canCheckNow: false,
      summary:
        "PND has not yet checked whether the underlying media and metadata are pinned.",
      whatWouldHelp:
        "Pin-status writeback from the /preserve flow (planned).",
    })
  } else {
    const checkedAny =
      pres.ipfs.retrievableCount > 0 ||
      pres.arweave.retrievableCount > 0 ||
      pres.onchain.totalCount > 0
    const probedAny =
      pres.ipfs.retrievableCount + pres.ipfs.unretrievableCount > 0 ||
      pres.arweave.retrievableCount > 0 ||
      pres.onchain.totalCount > 0
    const status: CheckStatus = checkedAny
      ? "Checked"
      : probedAny
        ? "Unable"
        : "Unable"
    areas.push({
      id: "preservation",
      title: "Preservation",
      status,
      canCheckNow: status === "Checked",
      summary: formatPreservationSummary(pres),
      whatWouldHelp:
        status === "Unable"
          ? "Worker hasn't probed CIDs for this artist yet; check back in a few minutes."
          : undefined,
    })
  }

  // 5. Public context — checkable via ENS url record.
  areas.push({
    id: "public-context",
    title: "Public context",
    status: inputs.ensUrl ? "Checked" : "NotFound",
    canCheckNow: true,
    summary: inputs.ensUrl
      ? `Public site found via ENS url record: ${inputs.ensUrl}.`
      : "PND did not find a public site for this wallet (ENS url record not set).",
  })

  return areas
}

function systemLabelForPlatform(p: PlatformId): string {
  switch (p) {
    case "foundation":
      return "Foundation"
    case "manifold":
      return "Manifold"
    case "mint":
      return "Mint"
    case "superrareV2":
      return "SuperRare"
    case "transient":
      return "Transient"
    case "sovereign":
      return "PND"
  }
}

// ── recommended next steps ───────────────────────────────────────────────

function buildNextSteps(args: {
  map: ContractMapEntry[]
  totals: InventoryTotals
  sovereignHouse: string | null
  ensUrl: string | null
  artistAddress: string
}): NextStep[] {
  const steps: NextStep[] = []
  const sharedTokens = args.map
    .filter((e) => e.type === "shared-creator" || e.type === "unknown")
    .reduce((s, e) => s + e.tokenCount, 0)

  if (sharedTokens > 0) {
    steps.push({
      id: "review-shared",
      title: "Check media and metadata locations for the largest contract groups",
      href: `/artist/${args.artistAddress}`,
      reason: `${sharedTokens} ${
        sharedTokens === 1 ? "token" : "tokens"
      } sit on shared or unknown contracts where the media and metadata sources are worth a closer look.`,
    })
  }

  if (args.totals.totalTokens > 0) {
    steps.push({
      id: "preserve",
      title: "Preserve files for works that depend on third-party storage",
      href: "/preserve",
      reason:
        "PND cannot yet verify pin status. Running the preserve flow gives you a copy of metadata and media you control.",
    })
  }

  if (!args.sovereignHouse) {
    steps.push({
      id: "auction",
      title: "Create an artist-owned auction contract for future sales",
      href: "/auction/new",
      reason:
        "An artist-owned auction contract keeps the sale path independent of platform marketplaces.",
    })
  }

  return steps.slice(0, 3)
}

// ── orchestrator ─────────────────────────────────────────────────────────

export async function buildDependencyReport(
  address: Address,
): Promise<DependencyReport> {
  const addrLower = address.toLowerCase()

  // Parallel calls against a `max:2` Postgres pool — keep this list
  // tight. Anything not feeding the new report shape gets dropped.
  // Active-auction/listing counts that v1 surfaced as separate cards are
  // now reflected in the sale-path area via the seller-listings payload.
  const [
    identity,
    fndContractMap,
    house,
    inventory,
    fndSales,
    listings,
    ensUrl,
    registryRecord,
    displayPath,
    preservation,
  ] = await Promise.all([
    getArtistIdentity(address),
    tryIndexer(() => getArtistContractMap(addrLower)),
    getSovereignHouseOf(address).catch(() => null),
    getArtistInventory(addrLower),
    tryIndexer(() => getFoundationSalesSummary(addrLower)),
    listingsWithTimeout(addrLower),
    getEnsUrl(address).catch(() => null),
    // Registry read — single multicall to the on-chain registry. On any
    // failure (registry not deployed, RPC blip), fall back to an empty
    // record so the rest of the report still renders cleanly.
    getCatalog(address).catch((): Catalog => ({
      artist: address,
      contracts: [],
      tokens: [],
      tokenRanges: [],
    })),
    getDisplayPathSummary(addrLower).catch(() => emptyDisplayPathSummary()),
    getPreservationSummary(addrLower).catch(() => emptyPreservationSummary()),
  ])

  // The set of contract addresses the artist has personally declared
  // in the on-chain registry. Used by the classifier to flag
  // auto-detected entries with `declaredInRegistry: true` AND to
  // surface declared-only contracts (those not picked up by any
  // platform adapter) as additional artist-owned rows.
  const declaredContracts = new Set<string>(
    registryRecord.contracts.map((c) => c.toLowerCase()),
  )

  const contractMap = buildContractMap({
    artistAddress: addrLower,
    fndRows: fndContractMap.ok ? fndContractMap.value : null,
    inventory,
    sovereignHouse: house,
    declaredContracts,
  })

  const inventoryTotals = computeInventoryTotals(contractMap)
  const dependencyRead = computeDependencyRead(contractMap, inventoryTotals)
  const areasToReview = buildAreasToReview({
    totals: inventoryTotals,
    map: contractMap,
    sovereignHouse: house,
    foundationSalesCount: fndSales.ok ? fndSales.value.saleCount : null,
    listings,
    ensUrl,
    platformErrors: inventory.platformErrors,
    displayPath,
    preservation,
  })
  const recommendedNextSteps = buildNextSteps({
    map: contractMap,
    totals: inventoryTotals,
    sovereignHouse: house,
    ensUrl,
    artistAddress: addrLower,
  })

  // Platform coverage: which platforms reported successfully + which
  // errored. Foundation/Sovereign aren't in the fan-out (they're served
  // by Ponder/factory), so they're always considered covered when the
  // indexer is healthy.
  const fannedOut: PlatformId[] = ["manifold", "superrareV2", "transient"]
  const errorPlatforms = new Set(
    inventory.platformErrors.map((e) => e.platform),
  )
  const covered: PlatformId[] = [
    "foundation",
    "sovereign",
    ...fannedOut.filter((p) => !errorPlatforms.has(p)),
  ]

  const indexerHealthy = fndContractMap.ok

  return {
    identity: {
      address: identity.address,
      ensName: identity.ensName,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
    },
    inventoryTotals,
    contractMap,
    dependencyRead,
    areasToReview,
    recommendedNextSteps,
    platformCoverage: {
      covered,
      errors: inventory.platformErrors,
    },
    displayPath,
    preservation,
    generatedAt: Math.floor(Date.now() / 1000),
    indexerHealthy,
  }
}

// Re-export so route handlers can `catch` it explicitly.
export { IndexerUnavailable }

export const DEPENDENCY_SCAN_TTL_S = 5 * 60
/**
 * Short TTL applied when the scan is incomplete (indexer unavailable,
 * platform timeouts). Lets the user retry and pick up the now-warm
 * lazy caches that any timed-out background scans populated, instead
 * of staring at the same partial banner for the full 5 minutes.
 */
export const DEPENDENCY_SCAN_PARTIAL_TTL_S = 30

/**
 * Custom cache wrapper: same `unstable_cache` L1 over a manually-managed
 * L2 in the `cache_entries` Postgres table — but with conditional TTL.
 * Complete reports cache for 5 min; partial ones (anything with an
 * `UnableToCheck` cause) cache for 30s only. We do the L2 read/write
 * inline rather than calling `pgCache(...)` because its single-TTL API
 * can't express this rule.
 */
async function fetchAndCacheReport(
  addressLower: string,
): Promise<DependencyReport> {
  const key = `artist-dependency:${addressLower}`

  if (sql) {
    try {
      const rows = await sql<Array<{ value: unknown }>>`
        SELECT value
        FROM cache_entries
        WHERE key = ${key} AND expires_at > NOW()
        LIMIT 1
      `
      if (rows.length > 0) {
        const raw = rows[0].value
        if (
          raw &&
          typeof raw === "object" &&
          raw !== null &&
          "v" in (raw as Record<string, unknown>)
        ) {
          return (raw as { v: DependencyReport }).v
        }
        return raw as DependencyReport
      }
    } catch {
      // Transient DB miss — fall through to compute.
    }
  }

  const fresh = await buildDependencyReport(addressLower as Address)
  const complete =
    fresh.indexerHealthy && fresh.platformCoverage.errors.length === 0
  const ttl = complete
    ? DEPENDENCY_SCAN_TTL_S
    : DEPENDENCY_SCAN_PARTIAL_TTL_S

  if (sql) {
    const envelope = { v: fresh }
    void sql`
      INSERT INTO cache_entries (key, value, expires_at)
      VALUES (${key}, ${sql.json(envelope as never)}, NOW() + (${ttl} || ' seconds')::interval)
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
    `.catch(() => {})
  }

  return fresh
}

/**
 * Cached scan-report builder. L1 is `unstable_cache` (per Node sandbox)
 * with a short revalidate so a stuck partial result doesn't linger
 * within one sandbox. L2 is the conditional-TTL `cache_entries` row
 * written by `fetchAndCacheReport`.
 */
export const getDependencyReport = unstable_cache(
  fetchAndCacheReport,
  ["artist-dependency-v7"],
  {
    revalidate: DEPENDENCY_SCAN_PARTIAL_TTL_S,
    tags: ["artist-dependency"],
  },
)
