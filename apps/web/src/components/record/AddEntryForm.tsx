"use client"

import { useEffect, useState } from "react"
import { useRegistryWrite } from "./useRegistryWrite"
import { extractShortError } from "./registryErrors"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/**
 * Single unified form for adding any pointer to the record.
 *
 * The artist enters a contract address and chooses scope:
 *   "The whole contract" → addContract
 *   "Specific tokens"    → addToken (single id) or addTokenRange (a range)
 *
 * The tokens input accepts either a single number ("42") or a range
 * ("1-100"); the form figures out which contract function to call and
 * collapses degenerate single-token ranges (e.g. "5-5") to addToken.
 * Removing the developer vocabulary (Contract / Token / Range) means
 * an artist who's never thought about the distinction still gets it
 * right.
 */
type Scope = "whole" | "specific"

type ParsedTokens =
  | { type: "single"; id: bigint }
  | { type: "range"; start: bigint; end: bigint }

function parseTokens(input: string): ParsedTokens | { error: string } {
  const trimmed = input.trim()
  if (trimmed === "") {
    return { error: "Enter a token ID or a range like 1-100." }
  }
  // Range form: "1-100" or "1 - 100" or with en-dash.
  const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/)
  if (rangeMatch) {
    const start = BigInt(rangeMatch[1])
    const end = BigInt(rangeMatch[2])
    if (start > end) return { error: "Start must be less than or equal to end." }
    if (start === end) return { type: "single", id: start }
    return { type: "range", start, end }
  }
  // Single id.
  if (/^\d+$/.test(trimmed)) {
    return { type: "single", id: BigInt(trimmed) }
  }
  return {
    error: "Use a single number like 42 or a range like 1-100.",
  }
}

export function AddEntryForm() {
  const { call, busy, error, reset, isSuccess } = useRegistryWrite()
  const [scope, setScope] = useState<Scope>("whole")
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

    if (scope === "whole") {
      setLocalErr(null)
      reset()
      call("addContract", [c as `0x${string}`])
      return
    }

    const parsed = parseTokens(tokens)
    if ("error" in parsed) {
      setLocalErr(parsed.error)
      return
    }
    setLocalErr(null)
    reset()
    if (parsed.type === "single") {
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

      <fieldset className="space-y-2">
        <legend className="text-xs text-gray-600 mb-1">
          What part of it?
        </legend>
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-6">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="scope"
              value="whole"
              checked={scope === "whole"}
              onChange={() => {
                setScope("whole")
                if (localErr) setLocalErr(null)
              }}
              disabled={busy}
            />
            The whole contract
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="scope"
              value="specific"
              checked={scope === "specific"}
              onChange={() => {
                setScope("specific")
                if (localErr) setLocalErr(null)
              }}
              disabled={busy}
            />
            Specific tokens
          </label>
        </div>
      </fieldset>

      {scope === "specific" && (
        <div className="space-y-1.5">
          <label
            htmlFor="record-tokens"
            className="block text-xs text-gray-600"
          >
            Which tokens?
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
            One token ID like <span className="font-mono">42</span>, or a
            range like <span className="font-mono">1-100</span>.
          </p>
        </div>
      )}

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
