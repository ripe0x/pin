"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAccount } from "wagmi"

/**
 * Landing component for /record (no address in URL).
 *
 * - Connected wallet → redirect to /record/<connected-addr>.
 * - Not connected → render a prompt + a manual address-entry form so a
 *   visitor can browse anyone's record without first connecting.
 */
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const ENS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export function CatalogLanding() {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isConnected && address) {
      router.replace(`/record/${address.toLowerCase()}`)
    }
  }, [isConnected, address, router])

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
    router.push(`/record/${encodeURIComponent(slug)}`)
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-2">
        <label htmlFor="record-input" className="block text-sm font-medium">
          Look up an artist record
        </label>
        <div className="flex gap-2">
          <input
            id="record-input"
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
            View
          </button>
        </div>
        {error && <p className="text-xs text-amber-700">{error}</p>}
      </form>

      <p className="text-sm text-gray-600">
        Connect a wallet to manage your own record. Otherwise, look up
        any address to see what they have declared.
      </p>
    </div>
  )
}
