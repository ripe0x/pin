"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const ENS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export function DependencyScanForm() {
  const router = useRouter()
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) {
      setError("Enter a wallet address or ENS name.")
      return
    }
    const looksValid = ADDRESS_RE.test(trimmed) || ENS_RE.test(trimmed)
    if (!looksValid) {
      setError("That does not look like an address or ENS name.")
      return
    }
    setError(null)
    const slug = ADDRESS_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed
    router.push(`/dependency/${encodeURIComponent(slug)}`)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label htmlFor="dep-input" className="block text-sm font-medium">
        Wallet address or ENS
      </label>
      <div className="flex gap-2">
        <input
          id="dep-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          placeholder="0x... or name.eth"
          className="flex-1 border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400"
        />
        <button
          type="submit"
          className="bg-fg text-bg text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 transition-opacity"
        >
          Scan
        </button>
      </div>
      {error && <p className="text-xs text-amber-700">{error}</p>}
      <p className="text-xs text-gray-500">
        PND only identifies what it can find in supported sources. Not
        found, Unknown, and Not yet do not mean absent everywhere.
      </p>
    </form>
  )
}
