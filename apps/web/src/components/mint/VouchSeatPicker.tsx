"use client"

/**
 * Vouch's mint selector: pick the specific open seat to mint — the contract's
 * `mint(uint256 tokenId)` has no lowest-available overload ("every Vouch is a
 * chosen voxel"). Registered in mint-slots.tsx under "vouch-seat", the same
 * key as the args builder that shapes the choice into calldata.
 *
 * Seat states arrive via `serverData` — the SAME `getSeatStates` read the
 * page already fetched for SeatGrid/RecentMints — so picking a seat costs
 * zero extra RPC. Visual language mirrors SeatGrid (13-column grid, dashed =
 * open); here open cells are buttons and minted cells are inert.
 */

import type { SeatState } from "@/lib/mint-onchain"
import type { PhaseSelectorProps } from "./mint-slots"

export function VouchSeatPicker({ serverData, selection, onSelect, disabled }: PhaseSelectorProps) {
  const seats = Array.isArray(serverData) ? (serverData as SeatState[]) : []
  if (seats.length === 0) return null
  const selected = typeof selection === "number" ? selection : null

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Pick your seat
        </span>
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
          {selected !== null ? `Seat #${selected}` : `${seats.filter((s) => !s.minted).length} open`}
        </span>
      </div>
      <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(13, minmax(0, 1fr))" }}>
        {seats.map((s) => {
          const base =
            "flex aspect-square items-center justify-center rounded-sm text-[8px] font-mono tabular-nums leading-none"
          if (s.minted) {
            return (
              <div
                key={s.tokenId}
                className={`${base} bg-gray-100 text-gray-300`}
                title={`Seat #${s.tokenId} · taken`}
              >
                {s.tokenId}
              </div>
            )
          }
          const isSelected = selected === s.tokenId
          return (
            <button
              key={s.tokenId}
              type="button"
              onClick={() => onSelect(s.tokenId)}
              disabled={disabled}
              aria-pressed={isSelected}
              className={`${base} transition-colors disabled:opacity-40 ${
                isSelected
                  ? "bg-fg text-bg"
                  : "border border-dashed border-gray-300 text-gray-400 hover:border-fg hover:text-fg"
              }`}
              title={`Seat #${s.tokenId} · open`}
            >
              {s.tokenId}
            </button>
          )
        })}
      </div>
      <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
        Dashed seats are open — pick one to mint. Filled seats are taken.
      </p>
    </div>
  )
}
