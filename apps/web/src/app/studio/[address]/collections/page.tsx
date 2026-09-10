import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { CollectionSettingsTool } from "@/components/studio/collections/CollectionSettingsTool"
import { getCollectionsByOwnerFromIndexer } from "@/lib/indexer-queries"

/**
 * Manage a Surface collection contract's owner/admin levers (renderer,
 * permanence locks, supply, royalty, cover, minters, creators). OwnerGate
 * (studio layout) keeps non-owners out; this page only guards an
 * unresolved/invalid studio address. The registry entry in lib/studio-tools.ts
 * gates visibility until the factory is deployed. The "your collections" list
 * is an owner-filtered SELECT (no chain reads); empty on a fork/sepolia
 * instance, where the paste-an-address input carries the flow.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export const metadata: Metadata = {
  title: "Collection settings",
  robots: { index: false, follow: false },
}

export default async function StudioCollectionsPage({ params }: { params: Params }) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!ADDRESS_RE.test(address)) notFound()

  const owned = (await getCollectionsByOwnerFromIndexer(address)) ?? []

  return (
    <div className="space-y-6">
      <CollectionSettingsTool owned={owned} />
    </div>
  )
}
