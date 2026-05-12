"use client"

import { useEffect, useState } from "react"
import { useRegistryWrite } from "./useRegistryWrite"
import { extractShortError } from "./registryErrors"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

type Kind = "contract" | "token" | "range"

/**
 * Single unified form for adding any pointer type to the record.
 *
 * One contract-address field (shared across types) plus a segmented
 * type selector. Conditional secondary fields appear for token /
 * range. Replaces the three separate per-section AddContract /
 * AddToken / AddRange forms — same writes, much less visual clutter.
 *
 * Empty by default: just a labeled card with the selector. Fields
 * unlock once the user picks what they're adding.
 */
export function AddEntryForm() {
  const { call, busy, error, reset, isSuccess } = useRegistryWrite()
  const [kind, setKind] = useState<Kind>("contract")
  const [addr, setAddr] = useState("")
  const [tokenId, setTokenId] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const [localErr, setLocalErr] = useState<string | null>(null)

  // Clear inputs on successful confirmation so the artist can add
  // another without manual reset. Watching `isSuccess` rather than
  // setting state during render avoids a React warning.
  useEffect(() => {
    if (isSuccess) {
      setAddr("")
      setTokenId("")
      setStart("")
      setEnd("")
    }
  }, [isSuccess])

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const c = addr.trim()
    if (!ADDRESS_RE.test(c)) {
      setLocalErr("Enter a valid contract address.")
      return
    }

    if (kind === "contract") {
      setLocalErr(null)
      reset()
      call("addContract", [c as `0x${string}`])
      return
    }

    if (kind === "token") {
      let id: bigint
      try {
        id = BigInt(tokenId.trim())
      } catch {
        setLocalErr("Token ID must be a non-negative integer.")
        return
      }
      if (id < 0n) {
        setLocalErr("Token ID must be a non-negative integer.")
        return
      }
      setLocalErr(null)
      reset()
      call("addToken", [c as `0x${string}`, id])
      return
    }

    // range
    let s: bigint
    let en: bigint
    try {
      s = BigInt(start.trim())
      en = BigInt(end.trim())
    } catch {
      setLocalErr("Start and end token IDs must be non-negative integers.")
      return
    }
    if (s < 0n || en < 0n) {
      setLocalErr("Start and end token IDs must be non-negative integers.")
      return
    }
    if (s > en) {
      setLocalErr("Start token ID must be less than or equal to end.")
      return
    }
    setLocalErr(null)
    reset()
    call("addTokenRange", [c as `0x${string}`, s, en])
  }

  return (
    <form
      onSubmit={onSubmit}
      className="border border-gray-200 rounded-md p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold">Add to your record</h2>
        <KindSelector kind={kind} setKind={setKind} disabled={busy} />
      </div>

      <input
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={addr}
        onChange={(e) => {
          setAddr(e.target.value)
          if (localErr) setLocalErr(null)
        }}
        placeholder="Contract 0x..."
        disabled={busy}
        className="w-full border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
      />

      {kind === "token" && (
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={tokenId}
          onChange={(e) => {
            setTokenId(e.target.value)
            if (localErr) setLocalErr(null)
          }}
          placeholder="Token ID"
          disabled={busy}
          className="w-full border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
        />
      )}

      {kind === "range" && (
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
              if (localErr) setLocalErr(null)
            }}
            placeholder="Start token ID"
            disabled={busy}
            className="w-full border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
          />
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={end}
            onChange={(e) => {
              setEnd(e.target.value)
              if (localErr) setLocalErr(null)
            }}
            placeholder="End token ID"
            disabled={busy}
            className="w-full border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-gray-500">{HINT[kind]}</p>
        <button
          type="submit"
          disabled={busy}
          className="bg-fg text-bg text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {busy ? "Adding..." : "Add to record"}
        </button>
      </div>

      {localErr && <p className="text-xs text-amber-700">{localErr}</p>}
      {error && (
        <p className="text-xs text-amber-700">{extractShortError(error)}</p>
      )}
    </form>
  )
}

const HINT: Record<Kind, string> = {
  contract: "Adds the whole contract.",
  token: "Adds one specific token on that contract.",
  range: "Adds a contiguous range of token IDs on that contract.",
}

function KindSelector({
  kind,
  setKind,
  disabled,
}: {
  kind: Kind
  setKind: (k: Kind) => void
  disabled: boolean
}) {
  const opts: Array<{ id: Kind; label: string }> = [
    { id: "contract", label: "Contract" },
    { id: "token", label: "Token" },
    { id: "range", label: "Range" },
  ]
  return (
    <div
      className="inline-flex border border-gray-200 rounded-full overflow-hidden text-xs"
      role="tablist"
      aria-label="Pointer type"
    >
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={kind === o.id}
          onClick={() => setKind(o.id)}
          disabled={disabled}
          className={`px-3 py-1 transition-colors ${
            kind === o.id
              ? "bg-fg text-bg"
              : "text-gray-600 hover:text-fg disabled:opacity-50"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
