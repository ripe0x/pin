"use client"

import { useEffect, useState } from "react"
import { useRegistryWrite } from "./useRegistryWrite"
import { extractShortError } from "./registryErrors"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/**
 * Single unified form for adding any pointer to the record. Two fields,
 * no radios:
 *
 *   1. Contract address (required)
 *   2. Tokens (optional) — accepts a single id ("42") or a range
 *      ("1-100"). Blank means "all tokens on this contract".
 *
 * On submit the form parses field 2 and dispatches to the matching
 * registry function: blank → addContract, single id → addToken, range
 * → addTokenRange. Degenerate ranges ("5-5") collapse to addToken.
 *
 * The artist never has to know the distinction between addToken and
 * addTokenRange, and "the whole contract" / "specific tokens"
 * vocabulary is gone — the optional field already implies the
 * either/or.
 */

type ParsedTokens =
  | { type: "all" }
  | { type: "single"; id: bigint }
  | { type: "range"; start: bigint; end: bigint }

function parseTokens(input: string): ParsedTokens | { error: string } {
  const trimmed = input.trim()
  if (trimmed === "") return { type: "all" }
  // Range form: "1-100" / "1 - 100" / with en-dash.
  const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/)
  if (rangeMatch) {
    const start = BigInt(rangeMatch[1])
    const end = BigInt(rangeMatch[2])
    if (start > end) {
      return { error: "Start must be less than or equal to end." }
    }
    if (start === end) return { type: "single", id: start }
    return { type: "range", start, end }
  }
  if (/^\d+$/.test(trimmed)) {
    return { type: "single", id: BigInt(trimmed) }
  }
  return {
    error: "Use a single number like 42, a range like 1-100, or leave blank.",
  }
}

export function AddEntryForm() {
  const { call, busy, error, reset, isSuccess } = useRegistryWrite()
  const [addr, setAddr] = useState("")
  const [tokens, setTokens] = useState("")
  const [localErr, setLocalErr] = useState<string | null>(null)

  useEffect(() => {
    if (isSuccess) {
      setAddr("")
      setTokens("")
    }
  }, [isSuccess])

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const c = addr.trim()
    if (!ADDRESS_RE.test(c)) {
      setLocalErr("Enter a valid contract address.")
      return
    }
    const parsed = parseTokens(tokens)
    if ("error" in parsed) {
      setLocalErr(parsed.error)
      return
    }
    setLocalErr(null)
    reset()
    if (parsed.type === "all") {
      call("addContract", [c as `0x${string}`])
    } else if (parsed.type === "single") {
      call("addToken", [c as `0x${string}`, parsed.id])
    } else {
      call("addTokenRange", [c as `0x${string}`, parsed.start, parsed.end])
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="border border-gray-200 rounded-md p-5 space-y-4"
    >
      <h2 className="text-sm font-semibold">Add to your record</h2>

      <div className="space-y-1.5">
        <label
          htmlFor="record-addr"
          className="block text-xs text-gray-600"
        >
          Contract address
        </label>
        <input
          id="record-addr"
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
          placeholder="0x..."
          disabled={busy}
          className="w-full border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
        />
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="record-tokens"
          className="block text-xs text-gray-600"
        >
          Which tokens?{" "}
          <span className="text-gray-400">(optional)</span>
        </label>
        <input
          id="record-tokens"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={tokens}
          onChange={(e) => {
            setTokens(e.target.value)
            if (localErr) setLocalErr(null)
          }}
          placeholder="42, or 1-100"
          disabled={busy}
          className="w-full border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
        />
        <p className="text-xs text-gray-500">
          Leave blank to add all tokens on this contract.
        </p>
      </div>

      <div className="flex items-center justify-end">
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
