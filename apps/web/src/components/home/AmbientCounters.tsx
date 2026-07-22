import { formatEther } from "viem"
import { getPlatformStats } from "@/lib/indexer-queries"

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

/**
 * One-line ambient counters above the footer. Hides any clause whose
 * value isn't yet meaningful, and hides the whole sentence when nothing
 * is.
 */
export async function AmbientCounters() {
  const stats = await getPlatformStats()
  if (!stats) return null

  const clauses: string[] = []
  if (stats.housesDeployed >= 2) {
    clauses.push(`${stats.housesDeployed} houses deployed.`)
  }
  if (stats.collectionsDeployed >= 1) {
    clauses.push(`${stats.collectionsDeployed} collections deployed.`)
  }
  if (stats.ethToArtistsWei > 0n) {
    clauses.push(`${formatEth(stats.ethToArtistsWei)} ETH to artists.`)
  }

  if (clauses.length === 0) return null

  return (
    <p className="text-xs font-mono text-gray-500 italic text-center pt-8">
      {clauses.join(" ")}
    </p>
  )
}
