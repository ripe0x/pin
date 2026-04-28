"use client"

import { useCallback, useMemo, useState, type ChangeEvent } from "react"
import { formatEther } from "viem"
import { cleanEthAmountInput, parseEthAmount } from "./parseEthAmount"

export type UseEthAmountInputOptions = {
  /**
   * Initial wei value, used for prefill (e.g. reserve from an existing
   * auction). Rendered via formatEther — once. After mount the user's
   * literal typed string is sovereign and is NOT overwritten if this
   * prop changes, so a German user retyping "0,5" doesn't have their
   * input mutated mid-keystroke. To force a reset use `setFromWei`.
   */
  initialWei?: bigint | null

  /**
   * Optional inclusive lower bound. The hook reports invalidity (with a
   * formatted error message) when the parsed value is below this. Pass
   * the contract-derived minimum bid here, for example.
   */
  min?: bigint

  /**
   * Override the auto-generated min error message. Default:
   * "Minimum is X ETH". Useful when the parent already shows the minimum
   * elsewhere and wants a shorter row-level message.
   */
  minLabel?: (minWei: bigint) => string
}

export type UseEthAmountInputResult = {
  /** Spread onto <input> — provides type, inputMode, value, onChange. */
  inputProps: {
    type: "text"
    inputMode: "decimal"
    value: string
    onChange: (e: ChangeEvent<HTMLInputElement>) => void
  }

  /** Raw user-typed string. Use only when you need to drive layout — the
   *  parsed bigint should drive contract calls. */
  rawValue: string

  /** Parsed wei. null when empty OR when input is invalid. */
  wei: bigint | null

  /** True when input is empty AND parses to a non-null wei AND meets min. */
  isValid: boolean

  /** True when the input is empty (not invalid — just empty). */
  isEmpty: boolean

  /** User-facing error message. null when valid OR empty (don't yell at
   *  users while they're still typing). */
  error: string | null

  /** Programmatically replace the displayed value from a wei amount.
   *  Use after async loads complete (e.g. fetched on-chain reserve). */
  setFromWei: (wei: bigint | null) => void

  /** Clear to empty. */
  reset: () => void
}

function defaultMinLabel(minWei: bigint): string {
  return `Minimum is ${formatEther(minWei)} ETH`
}

/**
 * Centralized state for ETH-amount inputs. See parseEthAmount for the
 * parsing rules; this hook adds React glue + min-bound validation.
 */
export function useEthAmountInput(
  options: UseEthAmountInputOptions = {},
): UseEthAmountInputResult {
  const { initialWei, min, minLabel = defaultMinLabel } = options

  const [rawValue, setRawValue] = useState<string>(() =>
    initialWei != null && initialWei > 0n ? formatEther(initialWei) : "",
  )

  const onChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setRawValue(cleanEthAmountInput(e.target.value))
  }, [])

  const setFromWei = useCallback((next: bigint | null) => {
    if (next == null) setRawValue("")
    else setRawValue(formatEther(next))
  }, [])

  const reset = useCallback(() => setRawValue(""), [])

  const result = useMemo(() => {
    const isEmpty = rawValue.trim() === ""
    if (isEmpty) {
      return { wei: null, isValid: false, isEmpty: true, error: null }
    }
    const parsed = parseEthAmount(rawValue)
    if (!parsed.ok) {
      return { wei: null, isValid: false, isEmpty: false, error: parsed.reason }
    }
    if (min != null && parsed.wei < min) {
      return {
        wei: parsed.wei,
        isValid: false,
        isEmpty: false,
        error: minLabel(min),
      }
    }
    return { wei: parsed.wei, isValid: true, isEmpty: false, error: null }
  }, [rawValue, min, minLabel])

  return {
    inputProps: {
      type: "text",
      inputMode: "decimal",
      value: rawValue,
      onChange,
    },
    rawValue,
    wei: result.wei,
    isValid: result.isValid,
    isEmpty: result.isEmpty,
    error: result.error,
    setFromWei,
    reset,
  }
}
