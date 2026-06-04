"use client"

import { PermanenceFundingPanel } from "@/components/editions/PermanenceFundingPanel"
import { PermanenceFloorStatus } from "@/components/editions/PermanenceFloorStatus"
import { HotPinStatus } from "@/components/editions/HotPinStatus"
import { PreservationBadge } from "@/components/editions/PreservationBadge"
import { EditionStatus, PND_CHAIN_ID } from "@/lib/pnd-editions"
import type { ArtworkPersistence } from "@/lib/editions-persistence"

/**
 * Static, dependency-free showcase of the mint-funded permanence UI
 * (docs/editions-permanence-funding.md) in representative in-progress states.
 * No wallet / chain / DB reads, so it renders anywhere and is trivial to
 * screenshot and share. Not a real edition — illustrative props only. Marked
 * "use client" only so the demo buttons can carry a no-op handler.
 */

const VAULT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const

const hotFunded: ArtworkPersistence = {
  kind: "ipfs",
  status: "retrievable",
  key: "bafyDemo",
  durability: "hot-funded",
  fundedThrough: 1_790_000_000, // 2026-09-21
}
const permanentFloor: ArtworkPersistence = {
  kind: "arweave",
  status: "retrievable",
  key: "arDemo",
  durability: "permanent-floor",
  fundedThrough: null,
}
const hotLapsed: ArtworkPersistence = {
  kind: "ipfs",
  status: "unretrievable",
  key: "bafyLapsed",
  durability: "hot-lapsed",
  fundedThrough: 1_700_000_000, // 2023-11-14
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-fg-subtle">{title}</p>
      <div className="rounded-lg border border-border bg-surface p-1">{children}</div>
    </div>
  )
}

export default function PermanencePreviewPage() {
  return (
    <div className="mx-auto max-w-md px-6 py-10 space-y-9">
      <header className="space-y-2">
        <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-fg-subtle">
          PND Editions · preview
        </p>
        <h1 className="text-xl font-medium tracking-tight">Storage funded by mints</h1>
        <p className="text-sm leading-relaxed text-fg-muted">
          A slice of every mint is set aside to keep the work&rsquo;s media alive,
          then spent on a pay-once Arweave floor or renewable pinning. PND never
          holds the funds or the media. Honest status throughout.
        </p>
      </header>

      <Card title="Mid-mint · accruing">
        <div className="px-3">
          <PermanenceFundingPanel
            vault={VAULT}
            bps={300}
            price={50_000_000_000_000_000n} // 0.05 ETH
            minted={37n}
            supplyCap={150n}
            status={EditionStatus.Open}
            chainId={PND_CHAIN_ID}
          />
        </div>
      </Card>

      <Card title="Fund a permanent floor · ready">
        <div className="p-3">
          <PermanenceFloorStatus state="idle" chainId={PND_CHAIN_ID} onFund={() => {}} />
        </div>
      </Card>

      <Card title="Fund a permanent floor · uploading">
        <div className="p-3">
          <PermanenceFloorStatus state="uploading" chainId={PND_CHAIN_ID} busy onFund={() => {}} />
        </div>
      </Card>

      <Card title="Fund a permanent floor · done (earned)">
        <div className="p-3">
          <PermanenceFloorStatus
            state="floored"
            arweaveUri="ar://Hq3…f2A"
            chainId={PND_CHAIN_ID}
          />
        </div>
      </Card>

      <Card title="Hot redundancy · IPFS via Pinata">
        <div className="p-3">
          <HotPinStatus
            cid="bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
            fundedThrough={1_824_600_000} // ≈2027-10
            nowSec={1_729_900_800} // fixed ref ≈2024-10 → "~3 years"
          />
        </div>
      </Card>

      <Card title="Honest status · durability">
        <div className="space-y-2 p-3">
          <PreservationBadge persistence={permanentFloor} />
          <PreservationBadge persistence={hotFunded} />
          <PreservationBadge persistence={hotLapsed} />
        </div>
      </Card>
    </div>
  )
}
