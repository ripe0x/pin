import { Suspense } from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { CreateCollectionWizard } from "@/components/studio/create/CreateCollectionWizard"
import { getFactoryStatus } from "@/lib/collection-onchain"

/**
 * The flagship create flow: ship a generative, edition, or renderer-native
 * collection with no Solidity. See CreateCollectionWizard for the step
 * graph; OwnerGate (studio layout) already keeps non-owners out, this page
 * only guards against an unresolved/invalid address like the other studio
 * tool pages.
 *
 * Wrapped in Suspense because CreateCollectionWizard reads useSearchParams
 * (the launch-link prefill) — Next requires a Suspense boundary around any
 * client component that does, same as AddEntryForm's on the catalog page.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export const metadata: Metadata = {
  title: "Create a collection",
  robots: { index: false, follow: false },
}

export default async function StudioCreatePage({ params }: { params: Params }) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!ADDRESS_RE.test(address)) notFound()

  const factoryStatus = await getFactoryStatus()

  return (
    <div className="space-y-6">
      <Suspense fallback={<div className="h-64 rounded-lg border border-gray-200 skeleton" />}>
        <CreateCollectionWizard artistAddress={address} factoryStatus={factoryStatus} />
      </Suspense>
    </div>
  )
}
