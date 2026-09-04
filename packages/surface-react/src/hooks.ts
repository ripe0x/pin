"use client"

import type { ProviderResult } from "@pin/release-spec"
import type {
  CoreReleaseProvider,
  MintQuote,
  MintQuoteInput,
  ReleaseRef,
  ReleaseState,
  TokenReadInput,
  TokenState,
  ValidatedRelease,
} from "@pin/surface-kit"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Address } from "viem"
import { toProviderViewState, type ProviderViewState } from "./state.ts"

type SharedOptions<T> = {
  enabled?: boolean
  initialResult?: ProviderResult<T> | null
}

type ReleaseStateOptions = SharedOptions<ReleaseState> & {
  provider: CoreReleaseProvider | null
  release: ValidatedRelease | null
  account?: Address
  refreshMs?: number
}

type MintQuoteOptions = SharedOptions<MintQuote> & {
  provider: CoreReleaseProvider | null
  input: MintQuoteInput | null
}

type ValidatedReleaseOptions = SharedOptions<ValidatedRelease> & {
  provider: CoreReleaseProvider | null
  release: ReleaseRef
  refreshMs?: number
}

type TokenStateOptions = SharedOptions<TokenState> & {
  provider: CoreReleaseProvider | null
  input: TokenReadInput | null
}

type ProviderHookState<T> = ProviderViewState<T> & {
  isRefreshing: boolean
  refresh: () => Promise<ProviderResult<T> | null>
}

function useProviderResult<T>(
  load: (signal: AbortSignal) => Promise<ProviderResult<T>>,
  options: SharedOptions<T> & { refreshMs?: number },
): ProviderHookState<T> {
  const enabled = options.enabled ?? true
  const [result, setResult] = useState<ProviderResult<T> | null>(options.initialResult ?? null)
  const [loading, setLoading] = useState(enabled && !options.initialResult)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(options.initialResult ? Date.now() : null)
  const active = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled) return null
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setLoading(true)
    try {
      const next = await load(controller.signal)
      if (!controller.signal.aborted) {
        setResult(next)
        setRefreshedAt(Date.now())
      }
      return controller.signal.aborted ? null : next
    } catch (error) {
      if (controller.signal.aborted) return null
      const failure = {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "The provider request failed",
        retryable: true,
      } as const
      setResult(failure)
      setRefreshedAt(Date.now())
      return failure
    } finally {
      if (active.current === controller) {
        active.current = null
        setLoading(false)
      }
    }
  }, [enabled, load])

  useEffect(() => {
    if (!enabled) {
      active.current?.abort()
      setLoading(false)
      return
    }
    void refresh()
    const refreshMs = options.refreshMs ?? 0
    const timer = refreshMs > 0
      ? window.setInterval(() => {
          if (document.visibilityState === "visible") void refresh()
        }, Math.max(12_000, refreshMs))
      : null
    return () => {
      if (timer !== null) window.clearInterval(timer)
      active.current?.abort()
    }
  }, [enabled, options.refreshMs, refresh])

  return {
    ...toProviderViewState(result, loading, refreshedAt),
    isRefreshing: loading && result !== null,
    refresh,
  }
}

export function useReleaseState(options: ReleaseStateOptions): ProviderHookState<ReleaseState> {
  const load = useCallback(
    (signal: AbortSignal) => {
      if (!options.provider || !options.release) {
        return Promise.resolve({ status: "unsupported", reason: "Release provider is not ready" } as const)
      }
      return options.provider.readState(options.release, options.account, signal)
    },
    [options.provider, options.release, options.account],
  )
  return useProviderResult(load, { ...options, enabled: (options.enabled ?? true) && Boolean(options.provider && options.release) })
}

export function useMintQuote(options: MintQuoteOptions): ProviderHookState<MintQuote> {
  const inputKey = options.input
    ? `${options.input.release.chainId}:${options.input.release.collection.toLowerCase()}:${options.input.account?.toLowerCase() ?? ""}:${options.input.quantity}:${options.input.referrer.toLowerCase()}`
    : ""
  const input = useMemo(() => options.input, [inputKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(
    (signal: AbortSignal) => {
      if (!options.provider || !input) {
        return Promise.resolve({ status: "unsupported", reason: "Mint quote is not ready" } as const)
      }
      return options.provider.quoteMint(input, signal)
    },
    [options.provider, input],
  )
  return useProviderResult(load, {
    ...options,
    enabled: (options.enabled ?? true) && Boolean(options.provider && input),
    refreshMs: 0,
  })
}

/** Read one token on demand. Deliberately has no refresh interval: callers
 * use this for bounded, visible-only galleries. */
export function useTokenState(options: TokenStateOptions): ProviderHookState<TokenState> {
  const inputKey = options.input
    ? `${options.input.release.chainId}:${options.input.release.collection.toLowerCase()}:${options.input.tokenId.toString()}`
    : ""
  const input = useMemo(() => options.input, [inputKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(
    (signal: AbortSignal) => {
      if (!options.provider || !input) {
        return Promise.resolve({ status: "unsupported", reason: "Token provider is not ready" } as const)
      }
      return options.provider.readToken(input, signal)
    },
    [options.provider, input],
  )
  return useProviderResult(load, {
    ...options,
    enabled: (options.enabled ?? true) && Boolean(options.provider && input),
    refreshMs: 0,
  })
}

export function useValidatedRelease(options: ValidatedReleaseOptions): ProviderHookState<ValidatedRelease> {
  const load = useCallback(
    (signal: AbortSignal) => {
      if (!options.provider) {
        return Promise.resolve({ status: "unsupported", reason: "Release provider is not ready" } as const)
      }
      return options.provider.validateRelease(options.release, signal)
    },
    [options.provider, options.release],
  )
  return useProviderResult(load, {
    ...options,
    enabled: (options.enabled ?? true) && Boolean(options.provider),
  })
}
