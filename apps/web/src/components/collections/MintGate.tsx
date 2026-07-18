"use client"

/**
 * Gate UI for GateHook-gated mints: eligibility answered as early as
 * possible, never a doomed transaction. The connected wallet is checked
 * automatically; anyone can also paste an address before connecting
 * (the check is an API lookup against the list stored for the root that
 * is active onchain — see lib/allowlist.ts for the trust model).
 */

import { useCallback, useEffect, useState } from "react"
import { isAddress } from "viem"

export type Eligibility = {
  gated: boolean
  eligible?: boolean | null
  proof?: `0x${string}`[]
  reason?: string
  cap?: string
}

async function fetchEligibility(
  collection: string,
  wallet: string,
): Promise<Eligibility | null> {
  try {
    const res = await fetch(
      `/api/collections/${collection.toLowerCase()}/allowlist?wallet=${wallet}`,
      { cache: "no-store" },
    )
    if (!res.ok) return null
    return (await res.json()) as Eligibility
  } catch {
    return null
  }
}

/** Eligibility of the connected wallet, fetched once per (collection,
 *  wallet). `undefined` while loading, `null` when the check failed. */
export function useEligibility(collection: `0x${string}`, wallet?: `0x${string}`) {
  const [result, setResult] = useState<Eligibility | null | undefined>(undefined)
  useEffect(() => {
    if (!wallet) {
      setResult(undefined)
      return
    }
    let cancelled = false
    setResult(undefined)
    void fetchEligibility(collection, wallet).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [collection, wallet])
  return result
}

export function EligibilityVerdict({ eligibility }: { eligibility: Eligibility | null | undefined }) {
  if (eligibility === undefined) {
    return (
      <p className="text-[11px] font-mono text-gray-400">Checking the allowlist…</p>
    )
  }
  if (eligibility === null) {
    return (
      <p className="text-[11px] font-mono text-gray-400">
        Could not check the allowlist. Try again shortly.
      </p>
    )
  }
  if (eligibility.eligible === true) {
    return (
      <p className="text-[11px] font-mono text-status-available">
        You are on the allowlist.
      </p>
    )
  }
  if (eligibility.eligible === false) {
    return (
      <p className="text-[11px] font-mono text-gray-500">
        This wallet is not on the allowlist.
      </p>
    )
  }
  return (
    <p className="text-[11px] font-mono text-gray-400">
      This mint is allowlisted, but the eligibility list has not been
      published to this page yet.
    </p>
  )
}

/** Pre-connect checker: paste any address, get a verdict without a wallet. */
export function AllowlistChecker({ collection }: { collection: `0x${string}` }) {
  const [input, setInput] = useState("")
  const [checked, setChecked] = useState<{ wallet: string; result: Eligibility | null } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const valid = isAddress(input.trim())

  const check = useCallback(async () => {
    const wallet = input.trim()
    if (!isAddress(wallet)) return
    setBusy(true)
    const result = await fetchEligibility(collection, wallet)
    setChecked({ wallet, result })
    setBusy(false)
  }, [collection, input])

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        Check the allowlist
      </p>
      <div className="flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors">
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setChecked(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void check()
          }}
          placeholder="0x…"
          spellCheck={false}
          className="w-0 flex-1 px-3 py-2.5 text-[11px] font-mono outline-none placeholder:text-gray-300 dark:placeholder:text-gray-700"
        />
        <button
          type="button"
          onClick={() => void check()}
          disabled={!valid || busy}
          className="px-4 text-[10px] font-mono uppercase tracking-wider text-gray-500 hover:text-fg border-l border-gray-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {busy ? "Checking…" : "Check"}
        </button>
      </div>
      {checked && (
        <p className="text-[11px] font-mono text-gray-500">
          {checked.result === null
            ? "Could not check. Try again shortly."
            : checked.result.eligible === true
              ? `${checked.wallet.slice(0, 6)}…${checked.wallet.slice(-4)} is on the allowlist.`
              : checked.result.eligible === false
                ? `${checked.wallet.slice(0, 6)}…${checked.wallet.slice(-4)} is not on the allowlist.`
                : "The eligibility list has not been published yet."}
        </p>
      )}
    </div>
  )
}
