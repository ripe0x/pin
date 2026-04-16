"use client"

import { useState } from "react"
import { PROVIDER_INFO, type ProviderType } from "@/lib/pinning"
import { createProvider } from "@/lib/pinning"

export function PinningSetup({
  onReady,
}: {
  onReady: (provider: ProviderType, apiKey: string) => void
}) {
  const [provider, setProvider] = useState<ProviderType>("pinata")
  const [apiKey, setApiKey] = useState("")
  const [validating, setValidating] = useState(false)
  const [error, setError] = useState("")

  const info = PROVIDER_INFO[provider]

  async function handleValidate() {
    if (!apiKey.trim()) {
      setError("Please enter your API key.")
      return
    }

    setValidating(true)
    setError("")

    try {
      const pinner = createProvider(provider, apiKey.trim())
      const valid = await pinner.validateKey()

      if (valid) {
        onReady(provider, apiKey.trim())
      } else {
        setError("Invalid API key. Please check and try again.")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not validate key. Please try again.")
    } finally {
      setValidating(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-lg font-medium">Pin to Pinata</h3>
        <p className="text-sm text-gray-500">
          Pinning keeps your art permanently available on IPFS. Think of it like
          backing up your files to the cloud — without it, your art could
          eventually disappear.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">API Key</label>
          <a
            href={info.signupUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline"
          >
            Sign up for {info.name} (free)
          </a>
        </div>
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-xs text-gray-500">
          {info.keyGuide}
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value)
            setError("")
          }}
          placeholder={info.keyPlaceholder}
          className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-black transition-colors"
        />
        <p className="text-xs text-gray-400">
          Your key stays in your browser and is sent directly to {info.name} — it never touches our servers.
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      <button
        onClick={handleValidate}
        disabled={validating || !apiKey.trim()}
        className="w-full bg-black text-white py-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {validating ? "Validating..." : "Continue"}
      </button>
    </div>
  )
}
