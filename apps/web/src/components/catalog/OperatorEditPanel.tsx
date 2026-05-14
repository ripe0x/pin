"use client"

import { useEffect, useState } from "react"
import { useReadContract } from "wagmi"
import { catalogAbi } from "@pin/abi"
import {
  ARTIST_RECORD_REGISTRY,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import type { Address } from "viem"
import { useCatalogWrite } from "./useCatalogWrite"
import { extractShortError } from "./catalogErrors"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/**
 * Operator management. The registry doesn't expose a "list operators"
 * function (each `isOperator` slot is a point lookup), so the UI is
 * lookup-then-act: enter a candidate address, see its current status,
 * and approve or revoke.
 */
export function OperatorEditPanel({ artist }: { artist: Address }) {
  const registry = ARTIST_RECORD_REGISTRY[MAINNET_CHAIN_ID]
  const { call, busy, error, reset, isSuccess } = useCatalogWrite()
  const [candidate, setCandidate] = useState("")
  const [localErr, setLocalErr] = useState<string | null>(null)
  const [checking, setChecking] = useState<Address | null>(null)

  // Live status lookup for whichever address the user committed via
  // "Check" — we re-read after a successful write so the panel's
  // current-status badge reflects reality.
  const { data: isOp, refetch } = useReadContract({
    address: registry,
    abi: catalogAbi,
    functionName: "isOperator",
    args: checking ? [artist, checking] : undefined,
    query: { enabled: !!checking },
  })

  useEffect(() => {
    if (isSuccess) {
      refetch()
    }
  }, [isSuccess, refetch])

  function onCheck() {
    const trimmed = candidate.trim() as Address
    if (!ADDRESS_RE.test(trimmed)) {
      setLocalErr("Enter a valid operator address.")
      return
    }
    setLocalErr(null)
    setChecking(trimmed)
  }

  function onToggle(approved: boolean) {
    if (!checking) return
    reset()
    call("setOperator", [checking, approved])
  }

  const statusKnown = checking !== null && isOp !== undefined

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Approve another address to add and remove pointers on your
        behalf. Operators can&rsquo;t approve other operators.
      </p>
      <div className="flex gap-2 flex-wrap">
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={candidate}
          onChange={(e) => {
            setCandidate(e.target.value)
            if (localErr) setLocalErr(null)
            setChecking(null)
          }}
          placeholder="Operator 0x..."
          className="flex-1 min-w-[280px] border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400"
        />
        <button
          type="button"
          onClick={onCheck}
          className="text-sm border border-gray-200 px-4 py-2 rounded-md hover:border-gray-400 transition-colors"
        >
          Check
        </button>
      </div>
      {localErr && <p className="text-xs text-amber-700">{localErr}</p>}

      {statusKnown && (
        <div className="border border-gray-200 rounded-md p-4 space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="space-y-0.5 min-w-0">
              <div className="font-mono text-sm">
                {checking.slice(0, 6)}...{checking.slice(-4)}
              </div>
              <div className="text-xs text-gray-500">
                Currently{" "}
                <span
                  className={
                    isOp ? "text-emerald-700" : "text-gray-500"
                  }
                >
                  {isOp ? "approved" : "not approved"}
                </span>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              {!isOp && (
                <button
                  type="button"
                  onClick={() => onToggle(true)}
                  disabled={busy}
                  className="text-sm bg-fg text-bg px-4 py-2 rounded-md hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? "Approving..." : "Approve"}
                </button>
              )}
              {isOp && (
                <button
                  type="button"
                  onClick={() => onToggle(false)}
                  disabled={busy}
                  className="text-sm border border-gray-200 px-4 py-2 rounded-md hover:border-amber-400 hover:text-amber-700 disabled:opacity-50"
                >
                  {busy ? "Revoking..." : "Revoke"}
                </button>
              )}
            </div>
          </div>
          {error && (
            <p className="text-xs text-amber-700">
              {extractShortError(error)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
