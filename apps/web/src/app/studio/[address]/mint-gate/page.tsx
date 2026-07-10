import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { MintGateTool } from "@/components/studio/mint-gate/MintGateTool"

/**
 * Gate a Sovereign Collection's mint with a GateHook allowlist + per-wallet
 * cap. OwnerGate (studio layout) already keeps non-owners out; this page
 * only guards against an unresolved/invalid studio address, same as the
 * other studio tool pages. The registry entry in lib/studio-tools.ts gates
 * this tool's visibility until GateHook is deployed on the current network.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export const metadata: Metadata = {
  title: "Mint gate",
  robots: { index: false, follow: false },
}

export default async function StudioMintGatePage({ params }: { params: Params }) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!ADDRESS_RE.test(address)) notFound()

  return (
    <div className="space-y-6">
      <MintGateTool />
    </div>
  )
}
