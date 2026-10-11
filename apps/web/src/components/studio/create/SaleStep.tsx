"use client"

/** Step 3: price, supply, mint window, royalty, payout, and the optional
 *  cover image URI (last field — the collection's own render is the
 *  primary artwork source; the cover is a fallback for marketplace cards). */

import { isAddress } from "viem"
import type { UseEthAmountInputResult } from "@/lib/useEthAmountInput"
import { isValidArtworkURI } from "@/lib/create-collection"
import type { WizardState } from "./types"
import { ArtworkField, PriceSupplyWindowFields, RoyaltyPayoutFields } from "./SharedFields"
import { BTN, BTN_SECONDARY } from "./wizard-ui"

type Setter = <K extends keyof WizardState>(key: K, value: WizardState[K]) => void

export function SaleStep({
  state,
  set,
  price,
  onBack,
  onNext,
}: {
  state: WizardState
  set: Setter
  price: UseEthAmountInputResult
  onBack: () => void
  onNext: () => void
}) {
  const royaltyBps = Math.round(Number(state.royaltyPct || "0") * 100)
  const royaltyOk = royaltyBps >= 0 && royaltyBps <= 5_000
  const capOk =
    state.openSupply || (Number(state.supplyCap) > 0 && Number.isFinite(Number(state.supplyCap)))
  const payoutOk = state.payout === "" || isAddress(state.payout)
  const priceOk = price.isEmpty || price.isValid
  const artworkTrimmed = state.artworkURI.trim()
  const artworkOk = artworkTrimmed === "" || isValidArtworkURI(artworkTrimmed)

  const canProceed = priceOk && royaltyOk && capOk && payoutOk && artworkOk

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Sale</h3>
      </header>

      <PriceSupplyWindowFields state={state} set={set} price={price} disabled={false} />
      <RoyaltyPayoutFields state={state} set={set} disabled={false} />
      <ArtworkField state={state} set={set} disabled={false} />

      <div className="flex gap-3">
        <button onClick={onBack} className={BTN_SECONDARY}>
          Back
        </button>
        <button onClick={onNext} disabled={!canProceed} className={BTN}>
          Continue
        </button>
      </div>
    </div>
  )
}
