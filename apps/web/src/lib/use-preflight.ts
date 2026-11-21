"use client"

import { useCallback, useState } from "react"

/**
 * Pending/error state for an async preflight (a `simulateContract` call)
 * that runs before a value-bearing `writeContract`. The simulation runs
 * the call against current chain state from the connected account, so a
 * write that would revert (stale price, outbid, closed window) surfaces
 * as an inline error before the wallet prompt instead of as a failed tx.
 *
 *   const preflight = usePreflight()
 *   preflight.run(async () => {
 *     const { request } = await simulateContract(config, { ...call, account, chainId })
 *     writeContract(request)
 *   })
 *
 * `error` is whatever the simulation threw; render it with
 * `formatWriteError` like a write error.
 */
export function usePreflight() {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError(null)
    setChecking(true)
    try {
      await fn()
    } catch (err) {
      setError(err)
    } finally {
      setChecking(false)
    }
  }, [])

  const reset = useCallback(() => setError(null), [])

  return { checking, error, run, reset }
}
