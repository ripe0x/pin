"use client"

/**
 * God-mode access for a hardcoded allowlist of wallet addresses.
 *
 * The allowlist comes from `NEXT_PUBLIC_GOD_MODE_ADDRESSES` (CSV of
 * 0x… addresses, comparison case-insensitive). A god-mode wallet sees
 * a small panel attached to the navbar where they can flip per-feature
 * debug toggles — currently just `debugPlatformChips` (renders the
 * source-platform tag on every gallery card).
 *
 * Toggle state lives in localStorage so it survives reloads. The
 * allowlist check happens against the connected wagmi wallet — no
 * wallet connected = no access, no panel.
 */

import { useEffect, useState, useCallback } from "react"
import { useAccount } from "wagmi"

const ALLOWLIST = (process.env.NEXT_PUBLIC_GOD_MODE_ADDRESSES ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => /^0x[0-9a-f]{40}$/.test(s))

const ALLOWLIST_SET = new Set(ALLOWLIST)

const LS_KEY_PREFIX = "pin:debug:"

type DebugFlag = "platformChips"

function lsKey(flag: DebugFlag): string {
  return LS_KEY_PREFIX + flag
}

function readFlag(flag: DebugFlag): boolean {
  if (typeof window === "undefined") return false
  return window.localStorage.getItem(lsKey(flag)) === "1"
}

function writeFlag(flag: DebugFlag, value: boolean): void {
  if (typeof window === "undefined") return
  if (value) window.localStorage.setItem(lsKey(flag), "1")
  else window.localStorage.removeItem(lsKey(flag))
}

/**
 * Whether the connected wallet is in the god-mode allowlist. Returns
 * false during SSR (no wallet context yet) and on disconnected state.
 */
export function useIsGodMode(): boolean {
  const { address } = useAccount()
  if (!address) return false
  return ALLOWLIST_SET.has(address.toLowerCase())
}

/**
 * One-flag debug toggle backed by localStorage. Reads on mount,
 * subscribes to a custom 'pin:debug-change' event so multiple
 * components stay in sync within a tab.
 */
export function useDebugFlag(
  flag: DebugFlag,
): [boolean, (value: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(false)

  useEffect(() => {
    setEnabled(readFlag(flag))
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ flag: DebugFlag; value: boolean }>).detail
      if (detail?.flag === flag) setEnabled(detail.value)
    }
    window.addEventListener("pin:debug-change", handler)
    return () => window.removeEventListener("pin:debug-change", handler)
  }, [flag])

  const setter = useCallback(
    (value: boolean) => {
      writeFlag(flag, value)
      setEnabled(value)
      window.dispatchEvent(
        new CustomEvent("pin:debug-change", { detail: { flag, value } }),
      )
    },
    [flag],
  )

  return [enabled, setter]
}
