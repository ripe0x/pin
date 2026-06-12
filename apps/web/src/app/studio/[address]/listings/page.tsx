import Link from "next/link"
import { notFound } from "next/navigation"
import { BulkDelistPanel } from "@/components/listings/BulkDelistPanel"

/**
 * Listings on other platforms: the same BulkDelistPanel /delist mounts,
 * plus the entry into the migrate flow. This is where the old
 * artist-page BulkDelistPanel + MigrationBanner moved.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export default async function StudioListingsPage({
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
          Listings on other platforms
        </h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          Your active listings on Foundation and SuperRare. Cancel them
          here — gas only, nothing routes through this site.
        </p>
      </header>

      <BulkDelistPanel artistAddress={address} showEmptyState />

      <div className="border border-gray-200 rounded-md p-4 flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            Moving to your own auction house?
          </p>
          <p className="text-xs text-gray-500">
            Cancel and relist in one guided flow — reserve and duration
            prefilled from each existing listing.
          </p>
        </div>
        <Link
          href={`/studio/${address}/migrate`}
          className="shrink-0 text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors"
        >
          Migrate →
        </Link>
      </div>
    </div>
  )
}
