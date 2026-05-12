"use client"

import { useState } from "react"
import { useRegistryWrite } from "./useRegistryWrite"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function AddContractForm() {
  const { call, busy, error, reset, isSuccess } = useRegistryWrite()
  const [value, setValue] = useState("")
  const [localErr, setLocalErr] = useState<string | null>(null)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!ADDRESS_RE.test(trimmed)) {
      setLocalErr("Enter a valid contract address.")
      return
    }
    setLocalErr(null)
    reset()
    call("addContract", [trimmed as `0x${string}`])
  }

  // Clear the input on successful confirmation so the user can add
  // another without manual reset.
  if (isSuccess && value) setValue("")

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (localErr) setLocalErr(null)
          }}
          placeholder="0x..."
          disabled={busy}
          className="flex-1 border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
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
        <p className="text-xs text-amber-700">
          {extractShortError(error)}
        </p>
      )}
    </form>
  )
}

export function extractShortError(err: unknown): string {
  if (!(err instanceof Error)) return "Transaction failed."
  // wagmi/viem errors include a `shortMessage` property after wrapping.
  const m = (err as { shortMessage?: string }).shortMessage
  return m ?? err.message.split("\n")[0]
}
