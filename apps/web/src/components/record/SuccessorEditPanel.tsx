"use client"

import { useState } from "react"
import { useAccount } from "wagmi"
import { useRegistryWrite } from "./useRegistryWrite"
import { extractShortError } from "./registryErrors"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/**
 * Form for declaring a successor. The successor pointer is append-
 * only: once set, it cannot be changed under this address. The UI
 * reflects this by requiring an explicit confirmation checkbox before
 * the Declare button enables. If the connected wallet already has a
 * successor declared, the form hides — extending the chain happens
 * from the successor's own address.
 */
export function SuccessorEditPanel({
  alreadyDeclared,
}: {
  alreadyDeclared: boolean
}) {
  const { call, busy, error, reset, isSuccess } = useRegistryWrite()
  const { address: connected } = useAccount()
  const [value, setValue] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [localErr, setLocalErr] = useState<string | null>(null)

  if (alreadyDeclared) {
    return (
      <p className="text-sm text-gray-500">
        Your successor is already declared. To extend the chain
        further, connect the successor wallet and declare its
        successor from there.
      </p>
    )
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = value.trim() as `0x${string}`
    if (!ADDRESS_RE.test(trimmed)) {
      setLocalErr("Enter a valid successor address.")
      return
    }
    if (connected && trimmed.toLowerCase() === connected.toLowerCase()) {
      setLocalErr("Successor must be a different address from yours.")
      return
    }
    if (!confirmed) {
      setLocalErr("Confirm that this is permanent before declaring.")
      return
    }
    setLocalErr(null)
    reset()
    call("setSuccessor", [trimmed])
  }

  if (isSuccess && (value || confirmed)) {
    setValue("")
    setConfirmed(false)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="border border-amber-200 bg-amber-50 rounded-md p-3 space-y-1 text-sm">
        <p className="font-medium text-amber-900">This is permanent.</p>
        <p className="text-amber-900">
          Once set, your successor cannot be changed under this address.
          Indexers walk this chain forward to aggregate your record
          across wallet migrations. Set this only while your current
          key is healthy.
        </p>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (localErr) setLocalErr(null)
          }}
          placeholder="Successor 0x..."
          disabled={busy}
          className="flex-1 border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !confirmed}
          className="bg-fg text-bg text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {busy ? "Declaring..." : "Declare"}
        </button>
      </div>
      <label className="flex items-start gap-2 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        I understand this is permanent and cannot be changed under this
        wallet.
      </label>
      {localErr && <p className="text-xs text-amber-700">{localErr}</p>}
      {error && (
        <p className="text-xs text-amber-700">{extractShortError(error)}</p>
      )}
    </form>
  )
}
