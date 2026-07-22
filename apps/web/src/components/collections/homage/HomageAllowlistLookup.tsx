"use client"

// Pre-public allowlist checker: paste any address (or ENS name) and see whether it's
// on the window-2 allowlist. Membership uses the ~1MB address companion (not the ~31MB
// proof file the mint later proves against), so the check costs zero RPC and no heavy
// fetch; an ENS name resolves through /api/homage/ens, which offloads to a hosted service
// (ensideas, with an ensdata fallback), so no RPC call is made for resolution either.

import {useCallback, useState} from "react"
import {isAddress} from "viem"
import {loadAllowlistAddresses} from "@/lib/homage/allowlist"
import {resolveEns} from "@/lib/homage/ens"

type Result = {who: string; listed: boolean} | null

// Shared across the predeploy landing (HomagePreview) and the live mint instrument
// (HomageMint) so the snapshot-date disclaimer stays in sync in both places.
export const ALLOWLIST_SNAPSHOT_CAPTION =
  "Eligibility is a fixed snapshot (July 21, 2026). Assets acquired after aren’t reflected."

export function HomageAllowlistLookup() {
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result>(null)
  const [err, setErr] = useState<string | null>(null)

  const check = useCallback(async () => {
    const raw = input.trim()
    if (!raw) return
    setBusy(true)
    setErr(null)
    setResult(null)
    try {
      let addr = raw
      if (!isAddress(raw)) {
        if (!raw.includes(".")) throw new Error("Enter an address or ENS name.")
        let resolved: string | null
        try {
          resolved = (await resolveEns(raw)).address
        } catch {
          throw new Error("Couldn't reach the ENS resolver. Paste an address.")
        }
        if (!resolved) throw new Error("That name doesn't resolve.")
        addr = resolved
      }
      setResult({who: raw, listed: (await loadAllowlistAddresses()).has(addr.toLowerCase())})
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Lookup failed.")
    } finally {
      setBusy(false)
    }
  }, [input])

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        Allowlist lookup · all punk holders + curated list
      </p>
      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setResult(null)
            setErr(null)
          }}
          onKeyDown={(e) => e.key === "Enter" && void check()}
          placeholder="0x… or name.eth"
          spellCheck={false}
          className="w-0 flex-1 rounded border border-gray-200 bg-surface px-3 py-2 text-[11px] font-mono outline-none focus:border-gray-400"
        />
        <button
          onClick={() => void check()}
          disabled={busy || !input.trim()}
          className="text-[10px] font-mono font-medium uppercase tracking-wider px-3 py-2 border border-gray-200 text-gray-500 hover:text-fg hover:border-gray-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "…" : "Check"}
        </button>
      </div>
      {result && (
        <p className="text-[10px] font-mono uppercase tracking-wider tabular-nums">
          {result.listed ? (
            <span className="text-status-available">{result.who} is on the allowlist</span>
          ) : (
            <span className="text-gray-400">{result.who} is not on the allowlist</span>
          )}
        </p>
      )}
      {err && <p className="text-[10px] font-mono text-gray-400">{err}</p>}
    </div>
  )
}
