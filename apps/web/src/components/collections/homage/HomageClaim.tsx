"use client"

// Claim window UI — the connected wallet's claimable punks (held directly or via
// delegate.xyz), each minting the homage for that exact punk id at the flat baseFee.
// Three routes, mirroring HomageMinter: direct `claim`, delegated `claimFor(vault)`,
// and permissionless `claimTo` (pay for any punk's holder). Plus a manual-id entry for
// punks acquired before the scan window.

import {useState} from "react"
import {type Address} from "viem"
import {homageFlows} from "@/lib/homage/contracts"
import {useOwnedPunks} from "@/lib/homage/punks"

type Flows = ReturnType<typeof homageFlows>
type Flow = ReturnType<Flows["claim"]> | ReturnType<Flows["claimFor"]> | ReturnType<Flows["claimTo"]>

export function HomageClaim({
  minter,
  address,
  refreshKey,
  disabled,
  getClaimValue,
  onClaim,
}: {
  minter: Address
  collection: Address
  address: Address
  refreshKey: number
  disabled: boolean
  getClaimValue: () => Promise<bigint | null>
  onClaim: (args: Flow) => void
}) {
  const {punks, status} = useOwnedPunks(minter, address, refreshKey)
  const flows = homageFlows(minter)
  const [manualId, setManualId] = useState("")
  const [pendingId, setPendingId] = useState<number | null>(null)

  async function claimDirect(id: number, vault?: Address) {
    setPendingId(id)
    const value = await getClaimValue()
    setPendingId(null)
    if (value === null) return
    const bid = BigInt(id)
    onClaim(vault ? flows.claimFor(bid, vault, value) : flows.claim(bid, value))
  }

  async function claimAnyoneFor(id: number) {
    setPendingId(id)
    const value = await getClaimValue()
    setPendingId(null)
    if (value === null) return
    onClaim(flows.claimTo(BigInt(id), value))
  }

  const manualValid = /^\d+$/.test(manualId) && Number(manualId) >= 0 && Number(manualId) <= 9999

  return (
    <div className="space-y-3">
      {status === "loading" && <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Finding your punks…</p>}

      {punks.length > 0 && (
        <ul className="space-y-2">
          {punks.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded border border-gray-200 bg-surface-muted/40 px-3 py-2">
              <span className="text-[11px] font-mono text-fg">
                Punk #{p.id}
                {p.wrapped && <span className="text-gray-400"> · wrapped</span>}
                {p.vault && <span className="text-gray-400"> · via vault {p.vault.slice(0, 6)}…</span>}
              </span>
              <button
                onClick={() => claimDirect(p.id, p.vault)}
                disabled={disabled || pendingId !== null}
                className="text-[10px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pendingId === p.id ? "…" : p.vault ? "Claim to vault" : "Claim"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {punks.length === 0 && status !== "loading" && (
        <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
          No claimable punks found for this wallet{status === "partial" ? " in the recent window" : ""}. If you hold one, enter its id
          below — claim verifies ownership (and delegation) on-chain.
        </p>
      )}

      {/* manual id: claim your own, or pay for any punk's holder (claimTo) */}
      <div className="space-y-2 pt-1">
        <div className="flex items-center gap-2">
          <input
            value={manualId}
            onChange={(e) => setManualId(e.target.value.replace(/[^\d]/g, "").slice(0, 4))}
            placeholder="Punk # (0–9999)"
            inputMode="numeric"
            className="w-0 flex-1 rounded border border-gray-200 bg-surface px-3 py-2 text-[11px] font-mono tabular-nums outline-none focus:border-gray-400"
          />
          <button
            onClick={() => manualValid && claimDirect(Number(manualId))}
            disabled={disabled || !manualValid || pendingId !== null}
            className="text-[10px] font-mono font-medium uppercase tracking-wider px-3 py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Claim mine
          </button>
        </div>
        <button
          onClick={() => manualValid && claimAnyoneFor(Number(manualId))}
          disabled={disabled || !manualValid || pendingId !== null}
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Or pay for this punk’s holder →
        </button>
      </div>
    </div>
  )
}
