"use client"

/**
 * renounceOwnership: the only lock a v2 collection has. It freezes every
 * token setter and, since the sale borrows the collection owner's authority,
 * every sale setter too. Offered only once the design's precondition holds
 * (docs/pnd-surface-v2-design.md section 8: the mint end has passed or the
 * sale is closed; see renouncePrecondition), and behind typing the name.
 */

import { type Abi } from "viem"
import { surfaceTokenV2Abi } from "@pin/abi"
import { renouncePrecondition, type SurfaceV2State } from "@/lib/surface-v2-studio"
import { useV2Write } from "./useV2Write"
import { Notice, Section, TypeToConfirm, WriteError } from "./ui"

export function RenounceSection({
  state,
  enabled,
  onDone,
}: {
  state: SurfaceV2State
  enabled: boolean
  onDone: () => void
}) {
  const w = useV2Write(onDone)
  const check = renouncePrecondition(state, Math.floor(Date.now() / 1000))
  return (
    <Section
      title="Renounce ownership"
      help="Makes the collection permanent: nobody can change its renderer, minter, supply cap, royalty or name again, and its sale's price, window and gate freeze with it. Payouts keep flowing."
    >
      {check.ok ? (
        <>
          <p className="text-xs text-gray-500">{check.note}</p>
          <TypeToConfirm
            name={state.name}
            label="Renounce ownership"
            busyLabel={w.label}
            busy={w.busy}
            disabled={!enabled}
            onConfirm={() =>
              w.run({ address: state.collection, abi: surfaceTokenV2Abi as Abi, functionName: "renounceOwnership", args: [] })
            }
          />
        </>
      ) : (
        <Notice tone="amber">{check.reason}</Notice>
      )}
      <WriteError error={w.error} action="Renounce" />
    </Section>
  )
}
