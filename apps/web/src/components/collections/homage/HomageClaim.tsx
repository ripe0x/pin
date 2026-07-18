"use client"

// Claim window UI — the connected wallet's claimable punks (held directly or via
// delegate.xyz), each minting the homage for that exact punk id at the flat baseFee.
// Three routes, mirroring HomageMinter: direct `claim`, delegated `claimFor(vault)`,
// and permissionless `claimTo` (pay for any punk's holder). Plus a manual-id entry for
// punks acquired before the scan window.

import {useState} from "react"
import Link from "next/link"
import {type Address} from "viem"
import {useReadContract, useReadContracts} from "wagmi"
import {PREFERRED_CHAIN} from "@/components/tx/tx-ui"
import {homageFlows, homageMinterAbi} from "@/lib/homage/contracts"
import {useOwnedPunks} from "@/lib/homage/punks"

type Flows = ReturnType<typeof homageFlows>
type Flow = ReturnType<Flows["claim"]> | ReturnType<Flows["claimFor"]> | ReturnType<Flows["claimTo"]>

export function HomageClaim({
  minter,
  collection,
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
  getClaimValue: (recipient?: Address, punkId?: bigint) => Promise<bigint | null>
  onClaim: (args: Flow) => void
}) {
  const {punks, status} = useOwnedPunks(minter, address, refreshKey)
  const flows = homageFlows(minter)
  const [manualId, setManualId] = useState("")
  const [pendingId, setPendingId] = useState<number | null>(null)

  // Reservation tag on each row — one batched read over the listed ids, not per-row.
  const unmintedIds = punks.filter((p) => !p.minted).map((p) => p.id)
  const reservedReads = useReadContracts({
    contracts: unmintedIds.map((id) => ({address: minter, abi: homageMinterAbi, functionName: "isReserved", args: [BigInt(id)]}) as const),
    query: {enabled: unmintedIds.length > 0, staleTime: 30_000},
  })
  const reservedById = new Map<number, boolean>()
  unmintedIds.forEach((id, i) => {
    const r = reservedReads.data?.[i]
    reservedById.set(id, r?.status === "success" && r.result === true)
  })

  async function claimDirect(id: number, vault?: Address) {
    setPendingId(id)
    // recipient is the vault (claimFor) or the connected wallet (direct claim) — the fee escalates on it
    const value = await getClaimValue(vault ?? address)
    setPendingId(null)
    if (value === null) return
    const bid = BigInt(id)
    onClaim(vault ? flows.claimFor(bid, vault, value) : flows.claim(bid, value))
  }

  async function claimAnyoneFor(id: number) {
    setPendingId(id)
    // claimTo mints to the punk's HOLDER — resolve their escalating fee from the id
    const value = await getClaimValue(undefined, BigInt(id))
    setPendingId(null)
    if (value === null) return
    onClaim(flows.claimTo(BigInt(id), value))
  }

  const manualValid = /^\d+$/.test(manualId) && Number(manualId) >= 0 && Number(manualId) <= 9999

  // Already claim-minted? Checked live for the typed id so the buttons disable with a
  // reason instead of letting the tx revert. (Owned-list rows carry their own flag.)
  const manualMinted = useReadContract({
    address: minter,
    abi: homageMinterAbi,
    functionName: "isMinted",
    args: [manualValid ? BigInt(manualId) : 0n],
    chainId: PREFERRED_CHAIN.id,
    query: {enabled: manualValid, staleTime: 30_000},
  })
  const manualIsMinted = manualValid && manualMinted.data === true

  return (
    <div className="space-y-3">
      {status === "loading" && <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Finding your punks…</p>}

      {punks.length > 0 && (
        <ul className="space-y-2">
          {punks.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded border border-gray-200 bg-surface-muted/40 px-3 py-2">
              <span className="text-[11px] font-mono text-fg">
                Punk {p.id}
                {p.wrapped && <span className="text-gray-400"> · wrapped</span>}
                {p.vault && <span className="text-gray-400"> · via vault {p.vault.slice(0, 6)}…</span>}
                {!p.minted && reservedById.get(p.id) && <span className="text-gray-400"> · reserved</span>}
              </span>
              {p.minted ? (
                <Link
                  href={`/collections/${collection}/${p.id}`}
                  className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors"
                >
                  Already minted · view →
                </Link>
              ) : (
                <button
                  onClick={() => claimDirect(p.id, p.vault)}
                  disabled={disabled || pendingId !== null}
                  className="text-[10px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {pendingId === p.id ? "…" : p.vault ? "Claim to vault" : "Claim"}
                </button>
              )}
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
            placeholder="Punk id (0–9999)"
            inputMode="numeric"
            className="w-0 flex-1 rounded border border-gray-200 bg-surface px-3 py-2 text-[11px] font-mono tabular-nums outline-none focus:border-gray-400"
          />
          <button
            onClick={() => manualValid && claimDirect(Number(manualId))}
            disabled={disabled || !manualValid || manualIsMinted || pendingId !== null}
            className="text-[10px] font-mono font-medium uppercase tracking-wider px-3 py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Claim mine
          </button>
        </div>
        {manualIsMinted ? (
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Punk {manualId} is already minted ·{" "}
            <Link href={`/collections/${collection}/${manualId}`} className="underline hover:text-fg">
              view →
            </Link>
          </p>
        ) : (
          <button
            onClick={() => manualValid && claimAnyoneFor(Number(manualId))}
            disabled={disabled || !manualValid || pendingId !== null}
            className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Or pay for this punk’s holder →
          </button>
        )}
      </div>
    </div>
  )
}
