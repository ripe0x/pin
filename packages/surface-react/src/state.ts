import type { ProviderResult } from "@pin/release-spec"

export type ProviderViewState<T> = {
  phase: "idle" | "loading" | "ready" | "reduced" | "blocked"
  result: ProviderResult<T> | null
  value: T | null
  message: string | null
  retryable: boolean
  refreshedAt: number | null
}

export function toProviderViewState<T>(
  result: ProviderResult<T> | null,
  loading: boolean,
  refreshedAt: number | null,
): ProviderViewState<T> {
  if (loading && result === null) {
    return { phase: "loading", result, value: null, message: null, retryable: false, refreshedAt }
  }
  if (result === null) {
    return { phase: "idle", result, value: null, message: null, retryable: false, refreshedAt }
  }
  if (result.status === "available") {
    return { phase: "ready", result, value: result.value, message: null, retryable: false, refreshedAt }
  }
  if (result.status === "partial") {
    return {
      phase: "reduced",
      result,
      value: result.value,
      message: `Unavailable: ${result.missing.join(", ")}`,
      retryable: false,
      refreshedAt,
    }
  }
  return {
    phase: "blocked",
    result,
    value: null,
    message: result.reason,
    retryable: result.status === "unavailable" && result.retryable,
    refreshedAt,
  }
}
