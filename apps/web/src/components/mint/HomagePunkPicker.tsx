"use client"

/**
 * Homage's claim-phase selector: pick which of your punks' homages to mint
 * (`claim(punkId)` — tokenId == punkId). Registered in mint-slots.tsx under
 * "homage-claim", the same key as the args builder that shapes the choice
 * into calldata. Mirrors the Homage site's ClaimPanel (web/app/page.tsx).
 *
 * Two paths to a selection, matching the two CryptoPunks ownership sources:
 *   - chips of the wallet's WRAPPED punks with an unminted homage — these
 *     arrive via `eligibilityData` (the homage-claim provider enumerates them
 *     through ERC721Enumerable; zero reads happen here),
 *   - a manual punk-id input for RAW punks (the 2017 market can't be
 *     enumerated cheaply, so ownership is verified per id) — the check fires
 *     ONLY on the explicit "verify" action, 1 multicall + ≤1 read per click.
 */

import { useState } from "react"
import type { PublicClient } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import { verifyPunkClaimable, type HomageClaimData } from "@/lib/mint-modules/homage"
import type { PhaseSelectorProps } from "./mint-slots"

export function HomagePunkPicker({
  eligibilityData,
  selection,
  onSelect,
  disabled,
}: PhaseSelectorProps) {
  const { address } = useAccount()
  const client = usePublicClient()
  const punks = (eligibilityData as HomageClaimData | undefined)?.punks ?? []
  const selected = typeof selection === "number" ? selection : null

  const [idText, setIdText] = useState("")
  const [checking, setChecking] = useState(false)
  const [checkNote, setCheckNote] = useState<string | null>(null)

  const typedId = /^\d{1,4}$/.test(idText) ? Number(idText) : null

  async function handleVerify() {
    if (typedId === null || !address || !client || checking) return
    setChecking(true)
    setCheckNote(null)
    try {
      const res = await verifyPunkClaimable(client as PublicClient, typedId, address)
      if (res.ok) {
        onSelect(typedId)
        setCheckNote(`You hold #${typedId}${res.wrapped ? " (wrapped)" : ""} — ready to mint.`)
      } else {
        setCheckNote(res.reason ?? `This wallet doesn't hold #${typedId}.`)
      }
    } catch {
      setCheckNote("Couldn't check ownership — try again.")
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Your claimable punks
        </span>
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
          {selected !== null ? `Punk #${selected}` : `${punks.length} found`}
        </span>
      </div>

      {punks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {punks.map((p) => {
            const isSelected = selected === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                disabled={disabled}
                aria-pressed={isSelected}
                title={p.wrapped ? `Punk #${p.id} (wrapped)` : `Punk #${p.id}`}
                className={`px-2 py-1 text-[11px] font-mono tabular-nums transition-colors disabled:opacity-40 ${
                  isSelected
                    ? "bg-fg text-bg"
                    : "border border-dashed border-gray-300 text-gray-500 hover:border-fg hover:text-fg"
                }`}
              >
                #{p.id}
                {p.wrapped && <span className="text-gray-400"> ⌾</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* Manual raw-punk entry: ownership verified per id, on click only. */}
      <div className="flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors">
        <input
          value={idText}
          onChange={(e) => {
            setIdText(e.target.value.replace(/[^\d]/g, "").slice(0, 4))
            setCheckNote(null)
          }}
          placeholder="Or enter a punk id (0–9999)"
          inputMode="numeric"
          disabled={disabled}
          className="flex-1 px-3 py-2 text-[12px] font-mono tabular-nums bg-transparent outline-none disabled:opacity-40"
        />
        <button
          type="button"
          onClick={() => void handleVerify()}
          disabled={disabled || checking || typedId === null || !address}
          className="px-3 text-[10px] font-mono uppercase tracking-wider text-gray-500 border-l border-gray-200 hover:text-fg transition-colors disabled:opacity-40"
        >
          {checking ? "Checking…" : "Verify"}
        </button>
      </div>
      {checkNote && (
        <p className="text-[10px] font-mono text-gray-500 leading-relaxed">{checkNote}</p>
      )}
      <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
        Dashed chips are wrapped punks found in your wallet whose homage is unminted. Hold a raw
        punk? Enter its id and verify — the homage carries the same number as the punk.
      </p>
    </div>
  )
}
