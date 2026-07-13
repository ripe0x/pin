import { notFound } from "next/navigation"
import { ManageCollectionTool } from "@/components/studio/collections/ManageCollectionTool"

/**
 * Manage a deployed collection: the admins & ownership panel (who holds
 * keys, the transfer-time warning) and the captures backfill flow
 * (docs/pnd-collection-thumbnails.md §5). The create wizard lives at
 * ../create; this is everything that comes after deploy.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export default async function StudioCollectionsPage({ params }: { params: Params }) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!ADDRESS_RE.test(address)) notFound()

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">Manage collections</h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          The owner-side panels for a deployed collection: who holds admin keys (and the
          warning that matters when a collection changes hands), plus per-token capture
          backfill so marketplace grids show each token&apos;s own frame.
        </p>
      </header>

      <ManageCollectionTool />
    </div>
  )
}
