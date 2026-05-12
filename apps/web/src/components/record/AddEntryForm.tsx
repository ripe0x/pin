"use client"

import { useEffect, useMemo, useState } from "react"
import { useRegistryWrite } from "./useRegistryWrite"
import { extractShortError } from "./registryErrors"
import { ContractPreview } from "./ContractPreview"
import { TokenPreview } from "./TokenPreview"
import { useContractInfo } from "./useContractInfo"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/**
 * Add form for /record.
 *
 *   1. Contract address (required) — preview card below shows
 *      name / symbol / standard / total supply when we can read them.
 *   2. Which tokens? (optional) — single id ("42") or range
 *      ("1-100"). Blank = all tokens. When a single id is entered,
 *      a small thumbnail+name preview confirms the artist has the
 *      right token. When a range is entered, a count summary appears.
 *   3. A "you're about to add..." summary line tells the artist
 *      exactly which contract function will fire and on what.
 *
 * Validation is intentionally non-blocking. Per the registry's "no
 * semantic checks" rule, the contract accepts anything; the form
 * surfaces what we can find but never refuses submission based on
 * on-chain state. Format errors (non-address, malformed range) DO
 * block — those are pure input mistakes.
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

function formatBigInt(n: bigint): string {
  if (n < 1_000_000_000n) return Number(n).toLocaleString()
  return n.toString()
}

export function AddEntryForm() {
  const { call, busy, error, reset, isSuccess } = useRegistryWrite()
  const [addr, setAddr] = useState("")
  const [tokens, setTokens] = useState("")
  const [localErr, setLocalErr] = useState<string | null>(null)

  const addrValid = ADDRESS_RE.test(addr.trim())
  const { data: contractInfo } = useContractInfo(addr)

  // Parse tokens lazily so the summary line + token preview can read
  // the result without re-parsing.
  const parsed = useMemo<ParsedTokens | { error: string }>(
    () => parseTokens(tokens),
    [tokens],
  )

  const parseFailed = "error" in parsed
  const tokensTouched = tokens.trim() !== ""

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
    if (parseFailed) {
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

  // Over-supply warning: when totalSupply is known, flag a token id or
  // range upper bound that's higher than what's been minted. Soft —
  // many contracts mint unbounded over time and the artist might be
  // declaring a range that fills out as new tokens drop.
  const overSupplyHint = computeOverSupplyHint(parsed, contractInfo)

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
        <ContractPreview address={addr} />
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
        {tokensTouched && parseFailed && (
          <p className="text-xs text-amber-700">{parsed.error}</p>
        )}

        {/* Per-scope preview */}
        {addrValid && !parseFailed && parsed.type === "single" && (
          <TokenPreview contract={addr} tokenId={parsed.id.toString()} />
        )}
        {addrValid && !parseFailed && parsed.type === "range" && (
          <div className="border border-gray-200 rounded-md p-3 text-sm">
            Adding{" "}
            <strong>
              {formatBigInt(parsed.end - parsed.start + 1n)}
            </strong>{" "}
            tokens — IDs {parsed.start.toString()} through{" "}
            {parsed.end.toString()}.
          </div>
        )}
        {overSupplyHint && (
          <p className="text-xs text-amber-700">{overSupplyHint}</p>
        )}
      </div>

      <SummaryLine
        addrValid={addrValid}
        parsed={parseFailed ? null : parsed}
        contractName={contractInfo?.name ?? null}
      />

      <div className="flex items-center justify-end">
        <button
          type="submit"
          disabled={busy || !addrValid || parseFailed}
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

/**
 * One-line "you're about to add..." summary so the artist sees the
 * exact action before clicking. Hidden until address is valid AND
 * tokens-field parses cleanly.
 */
function SummaryLine({
  addrValid,
  parsed,
  contractName,
}: {
  addrValid: boolean
  parsed: ParsedTokens | null
  contractName: string | null
}) {
  if (!addrValid || !parsed) return null
  const label = contractName ?? "this contract"
  let body: React.ReactNode
  if (parsed.type === "all") {
    body = (
      <>
        Adding <strong>all tokens</strong> on{" "}
        <strong>{label}</strong>.
      </>
    )
  } else if (parsed.type === "single") {
    body = (
      <>
        Adding <strong>token #{parsed.id.toString()}</strong> on{" "}
        <strong>{label}</strong>.
      </>
    )
  } else {
    body = (
      <>
        Adding <strong>tokens {parsed.start.toString()}–{parsed.end.toString()}</strong>{" "}
        on <strong>{label}</strong>.
      </>
    )
  }
  return <p className="text-sm text-gray-600">{body}</p>
}

function computeOverSupplyHint(
  parsed: ParsedTokens | { error: string },
  info: { totalSupply: string | null } | null,
): string | null {
  if (!info || info.totalSupply === null) return null
  if ("error" in parsed) return null
  if (parsed.type === "all") return null
  const supply = BigInt(info.totalSupply)
  if (supply === 0n) return null
  if (parsed.type === "single" && parsed.id >= supply) {
    return `Token #${parsed.id.toString()} is above the current supply (${formatBigInt(supply)}). It may not exist yet.`
  }
  if (parsed.type === "range" && parsed.end >= supply) {
    return `Range ends above the current supply (${formatBigInt(supply)}). Some tokens may not exist yet.`
  }
  return null
}
