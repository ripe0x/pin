"use client"

/**
 * Homage's claim-phase selector: pick which punk's homage to mint. Registered
 * in mint-slots.tsx under "homage-claim", the same key as the args builder
 * that shapes the choice into calldata. Mirrors the Homage site's claim UI,
 * including its full routing (Homage.sol's three claim paths):
 *
 *   - chips of punks claimable by this wallet — its own WRAPPED punks plus
 *     punks in delegate.xyz vaults that delegated it (tagged; those mint to
 *     the vault via claimFor). These arrive via `eligibilityData` (the
 *     homage-claim provider enumerates them; zero reads happen here),
 *   - a manual punk-id input for everything else — RAW punks (the 2017
 *     market can't be enumerated cheaply, so ownership is verified per id),
 *     per-id delegations, and pay-for-holder (claimTo: you pay, the punk's
 *     holder receives). The check fires ONLY on the explicit "verify" action.
 *
 * The selection it emits is a routed `HomageClaimSelection`; the args builder
 * maps the route to claim / claimFor / claimTo.
 */

import { useState } from "react"
import type { PublicClient } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import {
  verifyPunkClaimable,
  type HomageClaimData,
  type HomageClaimSelection,
} from "@/lib/mint-modules/homage"
import { shortAddress } from "@/lib/collection"
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
  const selected =
    selection && typeof selection === "object" && "id" in selection
      ? (selection as HomageClaimSelection)
      : null

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
      if (res.ok && res.route) {
        onSelect({ id: typedId, route: res.route } satisfies HomageClaimSelection)
        setCheckNote(
          res.route.via === "self"
            ? `You hold #${typedId}${res.wrapped ? " (wrapped)" : ""}. Ready to mint.`
            : res.route.via === "delegated"
              ? `Delegated to you. #${typedId}'s homage mints to vault ${shortAddress(res.route.vault)}.`
              : `You pay; #${typedId}'s homage mints to its holder ${shortAddress(res.route.holder)}.`,
        )
      } else {
        setCheckNote(res.reason ?? `Couldn't verify #${typedId}.`)
      }
    } catch {
      setCheckNote("Couldn't check ownership. Try again.")
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
          {selected !== null ? `Punk #${selected.id}` : `${punks.length} found`}
        </span>
      </div>

      {punks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {punks.map((p) => {
            const isSelected = selected?.id === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() =>
                  onSelect({
                    id: p.id,
                    route: p.vault ? { via: "delegated", vault: p.vault } : { via: "self" },
                  } satisfies HomageClaimSelection)
                }
                disabled={disabled}
                aria-pressed={isSelected}
                title={
                  p.vault
                    ? `Punk #${p.id} — delegated; mints to vault ${shortAddress(p.vault)}`
                    : p.wrapped
                      ? `Punk #${p.id} (wrapped)`
                      : `Punk #${p.id}`
                }
                className={`px-2 py-1 text-[11px] font-mono tabular-nums transition-colors disabled:opacity-40 ${
                  isSelected
                    ? "bg-fg text-bg"
                    : "border border-dashed border-gray-300 text-gray-500 hover:border-fg hover:text-fg"
                }`}
              >
                #{p.id}
                {p.vault ? (
                  <span className="text-gray-400"> ⇢</span>
                ) : p.wrapped ? (
                  <span className="text-gray-400"> ⌾</span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}

      {selected?.route.via === "delegated" && (
        <p className="text-[10px] font-mono text-gray-500 leading-relaxed">
          Delegated claim: the homage mints to vault {shortAddress(selected.route.vault)}.
        </p>
      )}
      {selected?.route.via === "anyone" && (
        <p className="text-[10px] font-mono text-gray-500 leading-relaxed">
          You pay; the homage mints to #{selected.id}&rsquo;s holder{" "}
          {shortAddress(selected.route.holder)}.
        </p>
      )}

      {/* Manual entry: ownership/delegation verified per id, on click only. */}
      <div className="flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors">
        <input
          value={idText}
          onChange={(e) => {
            setIdText(e.target.value.replace(/[^\d]/g, "").slice(0, 4))
            setCheckNote(null)
          }}
          placeholder="Or enter a punk id (0-9999)"
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
        Dashed chips are punks claimable by this wallet: wrapped punks it holds (⌾) and punks in
        vaults that delegated it via delegate.xyz (⇢, mints to the vault). Hold a raw punk, or
        want to pay for a holder&rsquo;s homage? Enter the id and verify. The homage carries the
        same number as the punk.
      </p>
    </div>
  )
}
