"use client"

/**
 * Client hooks that run the registered mint providers (mint-registries.ts)
 * under the app's RPC discipline. The providers are single-shot async
 * functions; ALL refresh policy lives here so no provider can accidentally
 * poll:
 *
 *   - `useMintQuote` — fetch on mount, re-fetch on an interval derived from
 *     the quote's own `ttlMs` but ONLY while the tab is visible
 *     (`document.visibilityState === "visible"`); a hidden tab pauses the
 *     clock and one refresh fires when it returns. Manual `refresh()` for
 *     the user-facing affordance. Never per-render: the effect re-runs only
 *     when the provider key / phase / wallet actually changes.
 *   - `usePhaseEligibility` — fetch once per (wallet, phase); no interval at
 *     all. Eligibility is wallet-state (owned tokens, allowlist caps) that
 *     only moves when the wallet acts, so polling it is pure waste.
 */

import { useCallback, useEffect, useState } from "react"
import type { PublicClient } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import {
  getEligibilityProvider,
  getQuoteProvider,
  type EligibilityResult,
  type MintQuote,
} from "@/lib/mint-registries"

function errMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message.split("\n")[0] : "unavailable"
}

// ── quote (2.2) ─────────────────────────────────────────────────────────────

// Floors so a provider returning a tiny ttl (or an error loop) can't hammer
// the RPC: at most one quote fetch per 5s while visible, errors retry at 30s.
const MIN_QUOTE_TTL_MS = 5_000
const ERROR_RETRY_MS = 30_000

export type QuoteState = {
  quote: MintQuote | null
  /** "idle" = no provider key (fixed-price collection). */
  status: "idle" | "loading" | "ready" | "error"
  error: string | null
  /** Manual refresh affordance — bumps a nonce, re-running the fetch effect. */
  refresh: () => void
}

export function useMintQuote(providerKey: string | null, phaseKey: string | null): QuoteState {
  const client = usePublicClient()
  const { address } = useAccount()
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<Omit<QuoteState, "refresh">>({
    quote: null,
    status: providerKey ? "loading" : "idle",
    error: null,
  })

  useEffect(() => {
    if (!providerKey || !client) {
      setState({ quote: null, status: "idle", error: null })
      return
    }
    const provider = getQuoteProvider(providerKey)
    if (!provider) {
      setState({ quote: null, status: "error", error: `Quote provider "${providerKey}" is not registered` })
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // Set when a scheduled refresh came due while the tab was hidden; the
    // visibilitychange listener consumes it exactly once on return.
    let staleWhileHidden = false

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (cancelled) return
        if (document.visibilityState === "visible") void run()
        else staleWhileHidden = true
      }, ms)
    }

    const run = async () => {
      try {
        const quote = await provider({ client: client as PublicClient, wallet: address, phaseKey })
        if (cancelled) return
        setState({ quote, status: "ready", error: null })
        schedule(Math.max(quote.ttlMs, MIN_QUOTE_TTL_MS))
      } catch (e) {
        if (cancelled) return
        // Keep the last good quote visible (marked stale by status) rather
        // than blanking the price on a transient quoter failure.
        setState((s) => ({ quote: s.quote, status: "error", error: errMessage(e) }))
        schedule(ERROR_RETRY_MS)
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible" && staleWhileHidden && !cancelled) {
        staleWhileHidden = false
        void run()
      }
    }

    document.addEventListener("visibilitychange", onVisibility)
    setState((s) => ({ ...s, status: s.quote ? s.status : "loading" }))
    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [providerKey, phaseKey, address, client, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, refresh }
}

// ── eligibility (2.3) ───────────────────────────────────────────────────────

export type EligibilityState = {
  /** "none" = phase declares no eligibility provider → open to anyone. */
  status: "none" | "checking" | "ready" | "error"
  result: EligibilityResult | null
  error: string | null
  refresh: () => void
}

export function usePhaseEligibility(
  providerKey: string | null,
  phaseKey: string | null,
): EligibilityState {
  const client = usePublicClient()
  const { address } = useAccount()
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<Omit<EligibilityState, "refresh">>({
    status: providerKey ? "checking" : "none",
    result: null,
    error: null,
  })

  useEffect(() => {
    // phaseKey may legitimately be null (a non-phased collection's gating);
    // only a missing provider key or client short-circuits.
    if (!providerKey || !client) {
      setState({ status: "none", result: null, error: null })
      return
    }
    const provider = getEligibilityProvider(providerKey)
    if (!provider) {
      setState({
        status: "error",
        result: null,
        error: `Eligibility provider "${providerKey}" is not registered`,
      })
      return
    }
    let cancelled = false
    setState({ status: "checking", result: null, error: null })
    provider({ client: client as PublicClient, wallet: address, phaseKey })
      .then((result) => {
        if (!cancelled) setState({ status: "ready", result, error: null })
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ status: "error", result: null, error: errMessage(e) })
      })
    return () => {
      cancelled = true
    }
  }, [providerKey, phaseKey, address, client, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, refresh }
}
