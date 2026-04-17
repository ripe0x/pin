"use client"

import { useState, useCallback, useRef } from "react"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import type { DiscoveredToken } from "@/lib/onchain-discovery"
import type { PinStatus, ProviderType, PinningProvider } from "@/lib/pinning"
import { createProvider, PROVIDER_INFO } from "@/lib/pinning"
import { PinningSetup } from "@/components/preserve/PinningSetup"
import { PreserveGrid } from "@/components/preserve/PreserveGrid"
import { PinProgress, type PinStats } from "@/components/preserve/PinProgress"
import Link from "next/link"

type TokenPinState = {
  token: DiscoveredToken
  metadataStatus: PinStatus
  mediaStatus: PinStatus
}

type Step = "connect" | "discover" | "setup" | "pin" | "done"

export default function PreservePage() {
  const { address, isConnected } = useAccount()
  const [step, setStep] = useState<Step>(isConnected ? "discover" : "connect")
  const [tokens, setTokens] = useState<TokenPinState[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState("")
  const providerRef = useRef<PinningProvider | null>(null)
  const [providerType, setProviderType] = useState<ProviderType | null>(null)
  const [pinning, setPinning] = useState(false)
  const [useCustomAddress, setUseCustomAddress] = useState(false)
  const [customAddress, setCustomAddress] = useState("")
  const [discoveredAddress, setDiscoveredAddress] = useState<string>("")
  const [stats, setStats] = useState<PinStats>({
    total: 0,
    pinned: 0,
    pinning: 0,
    failed: 0,
    queued: 0,
    lastError: undefined,
  })

  // The address to discover — custom or connected wallet
  const targetAddress = useCustomAddress ? customAddress.trim() : address

  /**
   * Check pin status for all tokens against a provider.
   * Updates token states and stats in place.
   */
  async function checkPinStatuses(
    tokenStates: TokenPinState[],
    pinner: PinningProvider,
  ) {
    const updated = [...tokenStates]
    let pinned = 0
    let total = 0

    for (const ts of updated) {
      if (ts.token.metadataCid) {
        total++
        try {
          const status = await pinner.checkPin(ts.token.metadataCid)
          ts.metadataStatus = status === "pinned" || status === "queued" ? "pinned" : "unknown"
          if (ts.metadataStatus === "pinned") pinned++
        } catch {
          // Leave as unknown
        }
      }
      if (ts.token.mediaCid) {
        total++
        try {
          const status = await pinner.checkPin(ts.token.mediaCid)
          ts.mediaStatus = status === "pinned" || status === "queued" ? "pinned" : "unknown"
          if (ts.mediaStatus === "pinned") pinned++
        } catch {
          // Leave as unknown
        }
      }
    }

    setTokens([...updated])
    setStats({ total, pinned, pinning: 0, failed: 0, queued: 0 })
    return { total, pinned }
  }

  // Step 2: Discover works
  const discoverWorks = useCallback(async () => {
    if (!targetAddress) return

    // Validate address format
    if (!targetAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      setDiscoverError("Please enter a valid Ethereum address.")
      return
    }

    setDiscovering(true)
    setDiscoverError("")

    try {
      const res = await fetch(`/api/artist/${targetAddress}/tokens`, { cache: "no-store" })
      if (!res.ok) throw new Error("Failed to discover tokens")
      const data = await res.json()

      const tokenStates: TokenPinState[] = data.tokens.map(
        (t: DiscoveredToken) => ({
          token: t,
          metadataStatus: "unknown" as PinStatus,
          mediaStatus: "unknown" as PinStatus,
        }),
      )

      setTokens(tokenStates)
      setDiscoveredAddress(targetAddress)

      // Count total CIDs to pin
      let totalCids = 0
      for (const ts of tokenStates) {
        if (ts.token.metadataCid) totalCids++
        if (ts.token.mediaCid) totalCids++
      }
      setStats((s) => ({ ...s, total: totalCids }))

      // If we have a saved provider, check what's already pinned.
      // Skip if the saved provider has since been disabled (e.g. web3.storage
      // API moved to maintenance mode), so users don't get stuck on a broken
      // choice they made days ago.
      let savedProvider: PinningProvider | null = null
      try {
        const savedType = localStorage.getItem("cg_pin_provider") as ProviderType | null
        const savedKey = localStorage.getItem("cg_pin_key")
        const savedInfo = savedType ? PROVIDER_INFO[savedType] : undefined
        if (savedType && savedKey && savedInfo && !savedInfo.disabled) {
          savedProvider = createProvider(savedType, savedKey)
          const valid = await savedProvider.validateKey()
          if (valid) {
            providerRef.current = savedProvider
            setProviderType(savedType)
            await checkPinStatuses(tokenStates, savedProvider)
          } else {
            savedProvider = null
          }
        } else if (savedType) {
          // Clear the saved provider when it's missing from PROVIDER_INFO
          // (removed type) or disabled, so the user gets a fresh setup.
          localStorage.removeItem("cg_pin_provider")
          localStorage.removeItem("cg_pin_key")
        }
      } catch {
        // No saved provider or invalid — that's fine
      }

      setStep("setup")
    } catch (err) {
      setDiscoverError(
        err instanceof Error ? err.message : "Something went wrong",
      )
    } finally {
      setDiscovering(false)
    }
  }, [targetAddress])

  // Step 3: Provider is ready
  function handleProviderReady(prov: ProviderType, apiKey: string) {
    providerRef.current = createProvider(prov, apiKey)
    setProviderType(prov)

    // Persist to localStorage for convenience
    try {
      localStorage.setItem("cg_pin_provider", prov)
      localStorage.setItem("cg_pin_key", apiKey)
    } catch {
      // Ignore storage errors
    }

    setStep("pin")
  }

  /**
   * Clear the saved provider + key so the user can pick a different one
   * or paste a fresh key. Used when the current key is failing (e.g. Pinata
   * free-tier account hitting the Pin-by-CID paywall).
   */
  function handleResetProvider() {
    providerRef.current = null
    setProviderType(null)
    try {
      localStorage.removeItem("cg_pin_provider")
      localStorage.removeItem("cg_pin_key")
    } catch {
      // Ignore storage errors
    }
    // Reset pin-related state so the fresh key starts clean.
    setStats((s) => ({
      total: s.total,
      pinned: 0,
      pinning: 0,
      failed: 0,
      queued: 0,
      lastError: undefined,
    }))
    setTokens((prev) =>
      prev.map((ts) => ({
        ...ts,
        metadataStatus: "unknown",
        mediaStatus: "unknown",
      })),
    )
    setStep("setup")
  }

  // Step 4: Pin all CIDs
  async function pinAll() {
    const pinner = providerRef.current
    if (!pinner) return
    setPinning(true)

    const updatedTokens = [...tokens]
    let pinned = 0
    let failed = 0
    let lastError: string | undefined

    // Helper to pin a single CID with delay between requests
    async function pinOne(
      cid: string,
      name: string,
    ): Promise<"pinned" | "queued" | "failed"> {
      // Delay between each API call to respect rate limits
      await new Promise((r) => setTimeout(r, 350))

      try {
        const result = await pinner!.pinByCid(cid, name)
        return result.status === "pinned" ? "pinned" : "queued"
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error"
        console.error(`Pin failed for ${cid.slice(0, 16)}...: ${msg}`)
        if (!lastError) lastError = msg
        return "failed"
      }
    }

    for (let i = 0; i < updatedTokens.length; i++) {
      const ts = updatedTokens[i]
      const label = ts.token.metadata?.name ?? `Token #${ts.token.tokenId}`

      // Stop early if we get auth/permission errors — no point continuing
      if (lastError && (lastError.includes("API key") || lastError.includes("invalid"))) {
        // Mark remaining as failed
        if (ts.token.metadataCid && ts.metadataStatus !== "pinned") {
          ts.metadataStatus = "failed"
          failed++
        }
        if (ts.token.mediaCid && ts.mediaStatus !== "pinned") {
          ts.mediaStatus = "failed"
          failed++
        }
        setTokens([...updatedTokens])
        setStats({ total: stats.total, pinned, failed, pinning: 0, queued: 0, lastError })
        continue
      }

      // Pin metadata CID
      if (ts.token.metadataCid && ts.metadataStatus !== "pinned") {
        ts.metadataStatus = "pinning"
        setTokens([...updatedTokens])
        setStats((s) => ({ ...s, pinning: s.pinning + 1 }))

        const status = await pinOne(ts.token.metadataCid, `${label} (metadata)`)
        ts.metadataStatus = status === "failed" ? "failed" : "pinned"
        if (status === "failed") failed++
        else pinned++

        setTokens([...updatedTokens])
        setStats({ total: stats.total, pinned, failed, pinning: 0, queued: 0, lastError })
      } else if (ts.metadataStatus === "pinned") {
        pinned++
      }

      // Pin media CID
      if (ts.token.mediaCid && ts.mediaStatus !== "pinned") {
        ts.mediaStatus = "pinning"
        setTokens([...updatedTokens])

        const status = await pinOne(ts.token.mediaCid, `${label} (media)`)
        ts.mediaStatus = status === "failed" ? "failed" : "pinned"
        if (status === "failed") failed++
        else pinned++

        setTokens([...updatedTokens])
        setStats({ total: stats.total, pinned, failed, pinning: 0, queued: 0, lastError })
      } else if (ts.mediaStatus === "pinned") {
        pinned++
      }
    }

    setPinning(false)
    setStep("done")
  }

  // Retry failed pins
  async function retryFailed() {
    const pinner = providerRef.current
    if (!pinner) return
    setPinning(true)

    const updatedTokens = [...tokens]
    let { pinned } = stats
    let failed = 0
    let lastError: string | undefined

    for (const ts of updatedTokens) {
      if (ts.metadataStatus === "failed" && ts.token.metadataCid) {
        ts.metadataStatus = "pinning"
        setTokens([...updatedTokens])
        await new Promise((r) => setTimeout(r, 350))

        try {
          const result = await pinner.pinByCid(ts.token.metadataCid)
          ts.metadataStatus = result.status === "pinned" ? "pinned" : "queued"
          pinned++
        } catch (err) {
          ts.metadataStatus = "failed"
          failed++
          const msg = err instanceof Error ? err.message : "Unknown error"
          if (!lastError) lastError = msg
        }
        setTokens([...updatedTokens])
      }

      if (ts.mediaStatus === "failed" && ts.token.mediaCid) {
        ts.mediaStatus = "pinning"
        setTokens([...updatedTokens])
        await new Promise((r) => setTimeout(r, 350))

        try {
          const result = await pinner.pinByCid(ts.token.mediaCid)
          ts.mediaStatus = result.status === "pinned" ? "pinned" : "queued"
          pinned++
        } catch (err) {
          ts.mediaStatus = "failed"
          failed++
          const msg = err instanceof Error ? err.message : "Unknown error"
          if (!lastError) lastError = msg
        }
        setTokens([...updatedTokens])
      }
    }

    setStats((s) => ({ ...s, pinned, failed, lastError }))
    setPinning(false)
  }

  // Update step when wallet connects/disconnects
  if (isConnected && step === "connect") {
    setStep("discover")
  }

  // How many CIDs still need pinning
  const unpinnedCount = tokens.reduce((n, ts) => {
    if (ts.token.metadataCid && ts.metadataStatus !== "pinned") n++
    if (ts.token.mediaCid && ts.mediaStatus !== "pinned") n++
    return n
  }, 0)

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="space-y-2 mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          Preserve Your Art
        </h1>
        <p className="text-gray-500">
          Foundation is shutting down their IPFS pinning. Use this tool to
          make sure your artwork stays permanently available.
        </p>
      </div>

      {/* Steps indicator */}
      <div className="flex items-center gap-2 mb-8">
        {(["connect", "discover", "setup", "pin"] as const).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-medium ${
                stepIndex(step) >= i
                  ? "bg-black text-white"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              {stepIndex(step) > i ? (
                <CheckIcon />
              ) : (
                i + 1
              )}
            </div>
            {i < 3 && (
              <div
                className={`h-px w-8 ${
                  stepIndex(step) > i ? "bg-black" : "bg-gray-200"
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      {step === "connect" && (
        <div className="space-y-6 text-center py-12">
          <p className="text-gray-500">Connect your wallet to get started.</p>
          <div className="flex justify-center">
            <ConnectButton />
          </div>
        </div>
      )}

      {step === "discover" && (
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-lg font-medium">Discover your works</h3>
            <p className="text-sm text-gray-500">
              We&apos;ll scan the Foundation contract to find all the works
              minted from this address. This reads directly from the Ethereum
              blockchain — no indexer or database needed.
            </p>
          </div>

          {discoverError && (
            <p className="text-sm text-red-500">{discoverError}</p>
          )}

          <button
            onClick={discoverWorks}
            disabled={discovering || (useCustomAddress && !customAddress.trim())}
            className="w-full bg-black text-white py-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-40"
          >
            {discovering
              ? "Scanning the blockchain..."
              : "Find My Foundation Works"}
          </button>

          {/* Custom address option — hidden by default */}
          {!discovering && (
            <div className="text-center">
              {!useCustomAddress ? (
                <button
                  onClick={() => setUseCustomAddress(true)}
                  className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Use a different address
                </button>
              ) : (
                <div className="space-y-3">
                  <input
                    type="text"
                    value={customAddress}
                    onChange={(e) => {
                      setCustomAddress(e.target.value)
                      setDiscoverError("")
                    }}
                    placeholder="0x..."
                    className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:border-black transition-colors"
                  />
                  <button
                    onClick={() => {
                      setUseCustomAddress(false)
                      setCustomAddress("")
                      setDiscoverError("")
                    }}
                    className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    Use connected wallet instead
                  </button>
                </div>
              )}
            </div>
          )}

          {discovering && (
            <p className="text-xs text-gray-400 text-center animate-pulse">
              This may take a moment — scanning on-chain history.
            </p>
          )}
        </div>
      )}

      {step === "setup" && (
        <div className="space-y-6">
          <div className="rounded-lg bg-gray-50 border border-gray-200 p-4 text-sm">
            Found <strong>{tokens.length} works</strong> on Foundation.
            {stats.pinned > 0 && stats.pinned === stats.total ? (
              <> All <strong>{stats.total} files</strong> are already pinned.</>
            ) : stats.pinned > 0 ? (
              <> <strong>{stats.pinned} of {stats.total} files</strong> already pinned. <strong>{unpinnedCount}</strong> still need pinning.</>
            ) : stats.total > 0 ? (
              <> That&apos;s <strong>{stats.total} files</strong> to pin (metadata + artwork for each).</>
            ) : null}
          </div>

          {tokens.length > 0 && (
            <>
              <PreserveGrid tokens={tokens} />
              {unpinnedCount > 0 ? (
                <div className="border-t border-gray-200 pt-6 space-y-3">
                  {providerRef.current ? (
                    <>
                      <button
                        onClick={() => setStep("pin")}
                        className="w-full bg-black text-white py-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
                      >
                        Pin {unpinnedCount} remaining {unpinnedCount === 1 ? "file" : "files"} to {providerType ? PROVIDER_INFO[providerType].name : ""}
                      </button>
                      <div className="text-center">
                        <button
                          onClick={handleResetProvider}
                          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                        >
                          Use a different API key
                        </button>
                      </div>
                    </>
                  ) : (
                    <PinningSetup onReady={handleProviderReady} />
                  )}
                </div>
              ) : stats.total > 0 && discoveredAddress ? (
                <div className="border-t border-gray-200 pt-6 text-center space-y-3">
                  <p className="text-sm text-gray-500">
                    All your art is already pinned. Share your artist page:
                  </p>
                  <Link
                    href={`/artist/${discoveredAddress}`}
                    className="inline-block bg-black text-white px-6 py-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
                  >
                    View Your Artist Page
                  </Link>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}

      {(step === "pin" || step === "done") && (
        <div className="space-y-6">
          <PinProgress stats={stats} isRunning={pinning} />

          {step === "pin" && !pinning && (
            <button
              onClick={pinAll}
              className="w-full bg-black text-white py-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
            >
              Pin {unpinnedCount > 0 ? `${unpinnedCount} files` : "All"} to {providerType ? PROVIDER_INFO[providerType].name : ""}
            </button>
          )}

          {step === "done" && stats.failed > 0 && !pinning && (
            <button
              onClick={retryFailed}
              className="w-full border border-gray-200 py-3 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              Retry {stats.failed} failed pins
            </button>
          )}

          {/* Always-available escape hatch to switch providers when pinning
              is failing (e.g. Pinata free-tier key silently paywalled). */}
          {!pinning && (
            <div className="text-center">
              <button
                onClick={handleResetProvider}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                Use a different API key
              </button>
            </div>
          )}

          <PreserveGrid tokens={tokens} />

          {step === "done" && discoveredAddress && (
            <div className="border-t border-gray-200 pt-6 text-center space-y-3">
              <p className="text-sm text-gray-500">
                Your art is preserved. Share your artist page:
              </p>
              <Link
                href={`/artist/${discoveredAddress}`}
                className="inline-block bg-black text-white px-6 py-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
              >
                View Your Artist Page
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function stepIndex(step: Step): number {
  const steps: Step[] = ["connect", "discover", "setup", "pin"]
  const idx = steps.indexOf(step)
  return idx === -1 ? steps.length : idx
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
