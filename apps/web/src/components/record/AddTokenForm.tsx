"use client"

import { useState } from "react"
import { useRegistryWrite } from "./useRegistryWrite"
import { extractShortError } from "./AddContractForm"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function AddTokenForm() {
  const { call, busy, error, reset, isSuccess } = useRegistryWrite()
  const [contract, setContract] = useState("")
  const [tokenId, setTokenId] = useState("")
  const [localErr, setLocalErr] = useState<string | null>(null)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const c = contract.trim()
    const t = tokenId.trim()
    if (!ADDRESS_RE.test(c)) {
      setLocalErr("Enter a valid contract address.")
      return
    }
    let tokenIdBig: bigint
    try {
      tokenIdBig = BigInt(t)
    } catch {
      setLocalErr("Token ID must be a non-negative integer.")
      return
    }
    if (tokenIdBig < 0n) {
      setLocalErr("Token ID must be a non-negative integer.")
      return
    }
    setLocalErr(null)
    reset()
    call("addToken", [c as `0x${string}`, tokenIdBig])
  }

  if (isSuccess && (contract || tokenId)) {
    setContract("")
    setTokenId("")
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_auto] gap-2">
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
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value)}
          placeholder="Token ID"
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
