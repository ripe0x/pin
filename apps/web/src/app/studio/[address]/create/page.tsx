import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { CreateCollectionWizard } from "@/components/studio/create/CreateCollectionWizard"

/**
 * The flagship create flow: ship a generative, edition, or renderer-native
 * collection with no Solidity. See CreateCollectionWizard for the step
 * graph; OwnerGate (studio layout) already keeps non-owners out, this page
 * only guards against an unresolved/invalid address like the other studio
 * tool pages.
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

  return (
    <div className="space-y-6">
      <CreateCollectionWizard artistAddress={address} />
    </div>
  )
}
