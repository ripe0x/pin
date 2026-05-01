"use client"

import { useEffect } from "react"
import { useAccount, useConnect, useConnectors } from "wagmi"

/**
 * Dev-only auto-connect helper for the local Anvil fork. When
 * `NEXT_PUBLIC_DEV_IMPERSONATE` is set, `lib/wagmi.ts` swaps the
 * rainbowkit-managed connector list out for a single `mock` connector
 * tied to that address. The mock connector's `defaultConnected: true`
 * flag *should* auto-connect on mount, but in practice wagmi's
 * persisted-store reconciliation skips that on a cold start. This
 * component is a belt-and-braces fix: on mount, if there's no
 * connection yet but a mock connector is registered, fire `connect()`
 * directly. Behaves as a no-op when no impersonation env var is set
 * (since there's no mock connector to find).
 */
export function DevImpersonate() {
  const connectors = useConnectors()
  const { connect, status } = useConnect()
  const { isConnected } = useAccount()

  useEffect(() => {
    if (isConnected) return
    if (status !== "idle") return
    const mock = connectors.find((c) => c.id === "mock" || c.type === "mock")
    if (!mock) return
    connect({ connector: mock })
  }, [connectors, connect, isConnected, status])

  return null
}
