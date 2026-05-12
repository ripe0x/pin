"use client"

import { useState } from "react"
import { useRegistryWrite } from "./useRegistryWrite"
import { extractShortError } from "./AddContractForm"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function AddRangeForm() {
  const { call, busy, error, reset, isSuccess } = useRegistryWrite()
  const [contract, setContract] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const [localErr, setLocalErr] = useState<string | null>(null)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const c = contract.trim()
    if (!ADDRESS_RE.test(c)) {
      setLocalErr("Enter a valid contract address.")
      return
    }
    let s: bigint
    let en: bigint
    try {
      s = BigInt(start.trim())
      en = BigInt(end.trim())
    } catch {
      setLocalErr("Start and end token IDs must be non-negative integers.")
      return
    }
    if (s < 0n || en < 0n) {
      setLocalErr("Start and end token IDs must be non-negative integers.")
      return
    }
    if (s > en) {
      setLocalErr("Start token ID must be less than or equal to end.")
      return
    }
    setLocalErr(null)
    reset()
    call("addTokenRange", [c as `0x${string}`, s, en])
  }

  if (isSuccess && (contract || start || end)) {
    setContract("")
    setStart("")
    setEnd("")
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr_auto] gap-2">
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={contract}
          onChange={(e) => setContract(e.target.value)}
          placeholder="Contract 0x..."
          disabled={busy}
          className="border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
        />
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={start}
          onChange={(e) => setStart(e.target.value)}
          placeholder="Start"
          disabled={busy}
          className="border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
        />
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          placeholder="End"
          disabled={busy}
          className="border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy}
          className="bg-fg text-bg text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {busy ? "Adding..." : "Add"}
        </button>
      </div>
      {localErr && <p className="text-xs text-amber-700">{localErr}</p>}
      {error && (
        <p className="text-xs text-amber-700">{extractShortError(error)}</p>
      )}
    </form>
  )
}
