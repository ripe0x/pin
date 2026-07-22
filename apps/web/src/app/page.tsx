import { Suspense } from "react"
import { unstable_cache } from "next/cache"
import { formatEther } from "viem"
import {
  getPlatformStats,
  IndexerUnavailable,
} from "@/lib/indexer-queries"
import { ActivityFeed } from "@/components/home/v2/ActivityFeed"

/**
 * Landing page — a reverse-chronological stream of sovereign actions
 * (deploy, list, mint, settle), with the artist as the subject of every
 * row. No platform-style work grid; the page leads with what artists are
 * doing on their own infrastructure rather than what's currently for
 * sale. The previous grid-style landing is preserved at `/index-prev`.
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8 space-y-12">
      <header className="space-y-3 pt-2">
        <h1 className="text-2xl md:text-[28px] font-semibold tracking-tight leading-tight max-w-xl">
          Independent artists running their own auctions, contracts, and
          sites on Ethereum.
        </h1>
        <Suspense fallback={null}>
          <CountersInline />
        </Suspense>
      </header>

      <section>
        <Suspense
          fallback={
            <p className="font-mono text-xs text-gray-400 italic py-12 text-center">
              loading activity…
            </p>
          }
        >
          <ActivityFeed />
        </Suspense>
      </section>
    </div>
  )
}

function formatEth(wei: bigint): string {
  const eth = Number(formatEther(wei))
  if (eth >= 100) return Math.round(eth).toString()
  if (eth >= 1) return stripTrailingZeros(eth.toFixed(2))
  if (eth >= 0.01) return stripTrailingZeros(eth.toFixed(3))
  return stripTrailingZeros(eth.toFixed(4))
}

function stripTrailingZeros(s: string): string {
  if (!s.includes(".")) return s
  return s.replace(/\.?0+$/, "")
}

// Counters are fed by the same Ponder tables the activity feed reads,
// so stale-by-30s mirrors the feed's freshness contract. Caching here
// also takes one Postgres aggregation query out of every home-page hit.
//
// `unstable_cache` JSON-encodes its values internally and throws on
// raw bigints, so we cache the wei amount as a decimal string and
// re-hydrate on read.
// Throw on null instead of caching it: a single timeout would
// otherwise hide the counters for the full 30s revalidate window.
const getCachedPlatformStats = unstable_cache(
  async (): Promise<{
    housesDeployed: number
    collectionsDeployed: number
    ethToArtistsWeiStr: string
  }> => {
    const stats = await getPlatformStats()
    if (!stats) throw new IndexerUnavailable()
    return {
      housesDeployed: stats.housesDeployed,
      collectionsDeployed: stats.collectionsDeployed,
      ethToArtistsWeiStr: stats.ethToArtistsWei.toString(),
    }
  },
  ["platform-stats-v2"],
  { revalidate: 30, tags: ["activity-feed"] },
)

async function CountersInline() {
  let cached: {
    housesDeployed: number
    collectionsDeployed: number
    ethToArtistsWeiStr: string
  }
  try {
    cached = await getCachedPlatformStats()
  } catch {
    return null
  }
  const stats = {
    housesDeployed: cached.housesDeployed,
    collectionsDeployed: cached.collectionsDeployed,
    ethToArtistsWei: BigInt(cached.ethToArtistsWeiStr),
  }

  const clauses: string[] = []
  if (stats.housesDeployed >= 1) {
    clauses.push(
      `${stats.housesDeployed} ${stats.housesDeployed === 1 ? "house" : "houses"} deployed`,
    )
  }
  if (stats.collectionsDeployed >= 1) {
    clauses.push(
      `${stats.collectionsDeployed} ${stats.collectionsDeployed === 1 ? "collection" : "collections"} deployed`,
    )
  }
  if (stats.ethToArtistsWei > 0n) {
    clauses.push(`${formatEth(stats.ethToArtistsWei)} ETH to artists`)
  }
  if (clauses.length === 0) return null

  return (
    <ul className="font-mono text-xs text-gray-500 flex flex-col gap-y-0.5 sm:flex-row sm:flex-wrap sm:gap-x-2">
      {clauses.map((c, i) => (
        <li key={c} className="flex items-baseline gap-x-2">
          {i > 0 && (
            <span aria-hidden="true" className="hidden sm:inline">·</span>
          )}
          <span>{c}</span>
        </li>
      ))}
    </ul>
  )
}
