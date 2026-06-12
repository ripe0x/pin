import { notFound } from "next/navigation"
import { DeployHouseCTA } from "@/components/auction/DeployHouseCTA"
import { StartSingleAuctionCard } from "@/components/auction/StartSingleAuctionCard"
import { SovereignBulkPanel } from "@/components/listings/SovereignBulkPanel"

/**
 * Sovereign auction house management. The heavy loads in
 * SovereignBulkPanel (per-token ownerOf sweep + AuctionCreated log
 * scan) used to fire on every visit the artist paid to their own
 * public page; they now run only when this tab is deliberately opened.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export default async function StudioAuctionsPage({
  params,
}: {
  params: Params
}) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!ADDRESS_RE.test(address)) notFound()

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">
          Your auction house
        </h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          A Sovereign auction house is your own contract — 0% fees,
          settlement straight to your wallet, no platform in between.
        </p>
      </header>

      {/* Renders only when no house is deployed yet. */}
      <DeployHouseCTA artistAddress={address} />

      {/* Link activates only once the house exists. */}
      <StartSingleAuctionCard artistAddress={address} />

      {/* Bulk list + cancel pending; renders only when a house exists. */}
      <SovereignBulkPanel artistAddress={address} />
    </div>
  )
}
