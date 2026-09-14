import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { AdminsTool } from "@/components/studio/admins/AdminsTool"
import { getCollectionsByOwnerFromIndexer } from "@/lib/indexer-queries"

/**
 * Delegate collection management to another wallet, and lock the renderer
 * once artwork is final. OwnerGate (studio layout) already keeps
 * non-owners out; this page only guards against an unresolved/invalid
 * studio address, same as the other studio tool pages. The registry entry
 * in lib/studio-tools.ts gates this tool's visibility until the factory is
 * deployed on the current network.
 *
 * The "your collections" list is a SELECT against the indexed
 * SurfaceCreated table (owner-filtered, no chain reads — AGENTS.md). On a
 * fork instance, or when the indexer is unavailable, the list is empty and
 * the tool's paste-an-address input carries the flow.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export const metadata: Metadata = {
  title: "Admins",
  robots: { index: false, follow: false },
}

export default async function StudioAdminsPage({ params }: { params: Params }) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!ADDRESS_RE.test(address)) notFound()

  const owned = (await getCollectionsByOwnerFromIndexer(address)) ?? []

  return (
    <div className="space-y-6">
      <AdminsTool owned={owned} />
    </div>
  )
}
